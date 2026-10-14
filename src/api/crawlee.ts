// For more information, see https://crawlee.dev/
import { Configuration, PlaywrightCrawler, downloadListOfUrls } from "crawlee";
import { Page } from "playwright";
import axios from 'axios';
// import { isWithinTokenLimit } from "gpt-tokenizer";

import { Config, configSchema } from "./configValidation.js";
import { ingestPdf, uploadPdfToS3 } from "./uploadToS3.js";


export async function crawl(rawConfig: Config) {
  const config = configSchema.parse(removeUndefinedFromObject(rawConfig));
  console.log("PARSED, final config:", config)

  let pageCounter = 0;
  const ingestionPromises: Promise<any>[] = [];
  // const results: Array<{ title: string; url: string; html: string }> = [];

  if (config.url) {
    console.log(`Crawling URL: ${config.url}`);
    if (process.env.NO_CRAWL !== "true") {
      // PlaywrightCrawler crawls the web using a headless
      // browser controlled by the Playwright library.

      let crawler: PlaywrightCrawler;

      try {
        crawler = new PlaywrightCrawler({

          // TODO: add these back...
          maxConcurrency: config.maxConcurrency,
          maxRequestsPerMinute: config.maxRequestsPerMinute,

          // Use the requestHandler to process each of the crawled pages.
          // removed , pushData from params... weird try catch behavior
          async requestHandler({ request, page, enqueueLinks, log }) {
            console.log(`Crawling: ${request.loadedUrl}...`);
            const title = await page.title();
            pageCounter++;
            log.info(
              `Crawling: Page ${pageCounter} / ${config.maxPagesToCrawl} - URL: ${request.loadedUrl}...`,
            );

            // Use custom handling for XPath selector
            if (config.selector) {
              if (config.selector.startsWith("/")) {
                await waitForXPath(
                  page,
                  config.selector,
                  config.waitForSelectorTimeout ?? 1000,
                );
              } else {
                await page.waitForSelector(config.selector, {
                  timeout: config.waitForSelectorTimeout ?? 1000,
                });
              }
            }

            // Expand all collapsible/toggled elements before extracting text
            // This ensures dynamically loaded content is rendered in the DOM
            const expandedCount = await page.evaluate(() => {
              // Find common patterns for collapsible elements
              const collapsibleSelectors = [
                'details',           // HTML5 details/summary
                'summary',           // Click to expand details
                '.toggled',          // Custom toggled class
                '.collapsed',        // Common collapsed class
                '[aria-expanded="false"]', // ARIA pattern
                '.accordion-header', // Accordion pattern
                '.expandable',       // Generic expandable
              ];

              let expandedCount = 0;

              for (const selector of collapsibleSelectors) {
                const elements = document.querySelectorAll(selector);
                elements.forEach(el => {
                  // Check if element is clickable and not already expanded
                  const isDetails = el.tagName === 'DETAILS';
                  const isSummary = el.tagName === 'SUMMARY';
                  const ariaExpanded = el.getAttribute('aria-expanded');
                  const hasCollapsedClass = el.classList.contains('collapsed');
                  const hasToggledClass = el.classList.contains('toggled');

                  // Expand if it's not already expanded
                  const shouldExpand = isDetails
                    ? !el.hasAttribute('open')
                    : isSummary
                      ? true  // Click summary to toggle details
                      : ariaExpanded === 'false' || hasCollapsedClass || hasToggledClass;

                  if (shouldExpand) {
                    try {
                      // Use native click to trigger JavaScript handlers
                      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                      expandedCount++;
                    } catch (e) {
                      console.warn(`Failed to click ${selector}:`, e);
                    }
                  }
                });
              }

              return expandedCount;
            });

            // Wait for dynamic content to load after expanding
            await page.waitForTimeout(500); // Give JS time to render expanded content

            log.info(`Expanded ${expandedCount} collapsible elements on ${request.loadedUrl}`);

            // page.on('console', message => console.log(`Page log: ${message.text()}`)); // refactored for memory leaks
            const consoleListener = (message: { text: () => any; }) => console.log(`Page log: ${message.text()}`);
            page.on('console', consoleListener);
            const html = await getPageHtml(page, config.selector);

            // Grab results from the page
            if (request.loadedUrl) {
              // results.push({ title, url: request.loadedUrl, html });


              // TODO: handle all file types (this is probably better than the transform function below)
              // TODO: NOOO Do it below instead, otherwise the match strategy never makes it here!!
              // const validFiletypes = ['.html', '.py', '.vtt', '.pdf', '.txt', '.srt', '.docx', '.ppt', '.pptx']
              // if (validFiletypes.some(ext => req.url.endsWith(ext))) {
              //   // If URL is a file, send it to handleFile
              //   handleFile(req.url, config.courseName);
              //   return null; // Returning null will prevent the URL from being enqueued
              // }

              // Asynchronously call the ingestWebscrape endpoint without awaiting the result
              if (html) {
                const ingestUrl = process.env.INGEST_URL;

                if (!ingestUrl) {
                  console.error('Error: INGEST_URL environment variable is not defined.');
                  return;
                }

                fetch(ingestUrl, {
                  "method": "POST",
                  "headers": {
                    "Accept": "*/*",
                    "Accept-Encoding": "gzip, deflate",
                    "Content-Type": "application/json"
                  },
                  "body": JSON.stringify({
                    base_url: config.url,
                    url: request.loadedUrl,
                    readable_filename: title,
                    content: html,
                    course_name: config.courseName,
                    groups: config.documentGroups,
                    // s3_paths: s3Key,
                  })
                })
                  .then(response => response.text())
                  // .then(text => {
                  //   console.log(`In success case -- Data ingested for URL: ${request.loadedUrl}`);
                  //   console.log(text)
                  // })
                  .catch(err => console.error(err));

                // ingestionPromises.push(
                //   axios.post('https://flask-production-751b.up.railway.app/ingest-web-text', {
                //     base_url: config.url,
                //     url: request.loadedUrl,
                //     title: title,
                //     content: html,
                //     courseName: config.courseName,
                //   }).then(() => {
                //     console.log(`Data ingested for URL: ${request.loadedUrl}`);
                //   }).catch(error => {
                //     console.error(`Failed to ingest data for URL: ${request.loadedUrl}`, error.name, error.message, error.data);
                //   })
                // )
              } else {
                console.error('Error: URL is undefined. Title is: ', title);
              }
            }

            // Disabled this due to weird type error all of a sudden, after adding the try catch
            // if (config.onVisitPage) {
            //   await config.onVisitPage({ page, pushData });
            // }

            page.off('console', consoleListener); // remove listener to avoid memory leak

            // Extract links from the current page and add them to the crawling queue.
            // Docs https://crawlee.dev/docs/introduction/adding-urls#filtering-links-to-same-domain
            // 1. scrape all -- wander the internet.
            // 2. scrape domain and all subdomains.
            // 3. scrape just equal and below the given URL -- match statement.
            if (config.scrapeStrategy == 'all' || config.scrapeStrategy == 'same-domain' || config.scrapeStrategy == 'same-hostname') {
              await enqueueLinks({
                strategy: config.scrapeStrategy,
                exclude:
                  typeof config.exclude === "string"
                    ? [config.exclude]
                    : config.exclude ?? [],

                // Keep this here so if we encounter .pdfs (no matter what URL or strategy), we still grab them
                transformRequestFunction(req) {
                  if (req.url.endsWith('.pdf')) {
                    // Download PDFs specially
                    console.log(`Downloading PDF: ${req.url}`);
                    handlePdf(config.courseName, config.url, req.url, config.documentGroups);
                    return false;
                  } else {
                    return req;
                  }
                },
              })
            } else {
              // strategy: 'equal-and-below' == stay on the same domain and subdomains (aka. hostname)
              await enqueueLinks({
                strategy: 'same-hostname',
                globs:
                  typeof config.match === "string" ? [config.match] : config.match,
                exclude:
                  typeof config.exclude === "string"
                    ? [config.exclude]
                    : config.exclude ?? [],

                // Keep this here so if we encounter .pdfs (no matter what URL or strategy), we still grab them
                transformRequestFunction(req) {
                  if (req.url.endsWith('.pdf')) {
                    // Download PDFs specially
                    console.log(`Downloading PDF: ${req.url}`);
                    handlePdf(config.courseName, config.url, req.url, config.documentGroups);
                    return false;
                  } else {
                    return req;
                  }
                },
              });
            }
          },
          // Comment this option to scrape the full website.
          maxRequestsPerCrawl: config.maxPagesToCrawl,
          // Uncomment this option to see the browser window.
          // headless: false,
          preNavigationHooks: [
            // Abort requests for certain resource types
            async ({ request, page, log }) => {
              // If there are no resource exclusions, return
              const RESOURCE_EXCLUSTIONS = config.resourceExclusions ?? [];
              if (RESOURCE_EXCLUSTIONS.length === 0) {
                return;
              }
              if (config.cookie) {
                const cookies = (
                  Array.isArray(config.cookie) ? config.cookie : [config.cookie]
                ).map((cookie: { name: any; value: any; }) => {
                  return {
                    name: cookie.name,
                    value: cookie.value,
                    url: request.loadedUrl,
                  };
                });
                await page.context().addCookies(cookies);
              }
              await page.route(`**\/*.{${RESOURCE_EXCLUSTIONS.join()}}`, (route) =>
                route.abort("aborted"),
              );
              log.info(
                `Aborting requests for as this is a resource excluded route`,
              );
            },
          ],
        },
          new Configuration({
            persistStorage: false,
          }));

        const isUrlASitemap = /sitemap.*\.xml$/.test(config.url);
        if (isUrlASitemap) {
          const listOfUrls = await downloadListOfUrls({ url: config.url });

          // Add the initial URL to the crawling queue.
          await crawler.addRequests(listOfUrls);

          await crawler.run();
        } else {
          // Add first URL to the queue and start the crawl.
          await crawler.run([config.url]);
        }
        if (crawler) {
          await crawler.teardown();
          // const store = await KeyValueStore.open();
          // await store.drop();
        }
      }

      catch (error) {
        console.error(`Error when instantiating crawler: ${error}`);
      }
    }
  }
  // Before returning from the function, wait for all the ingestion promises to resolve
  await Promise.all(ingestionPromises);
  return pageCounter;
}

// ----- HELPERS -----

async function handlePdf(courseName: string, base_url: string, url: string, documentGroups: string[]) {
  try {
    const s3Key = await uploadPdfToS3(url, courseName);
    await new Promise(resolve => setTimeout(resolve, 3000));
    await ingestPdf(s3Key, courseName, base_url, url, documentGroups);
  } catch (error) {
    console.error(`Error in handlePDF: ${error}`);
  }
}
function getPageHtml(page: Page, selector = "body") {
  return page.evaluate((selector) => {
    const elementsToRemove = document.querySelectorAll(
      'script, style, noscript, svg, iframe, video, audio, canvas, object, embed, link, meta, title, area, base, col, command, track, wbr'
    );
    elementsToRemove.forEach(element => element.remove());

    // Keep forms/inputs for now but exclude them from text extraction
    const formElements = document.querySelectorAll('form, input, button, select, textarea');
    formElements.forEach(element => element.remove());

    const elementsToExclude = document.querySelectorAll('header, footer, nav');
    elementsToExclude.forEach(element => element.remove());

    const sidebarElements = document.querySelectorAll('#sidebar-right, .menu-block-wrapper, .block-menu-block');
    sidebarElements.forEach(element => element.remove());

    // Convert tables to markdown format with explicit boundaries for chunking
    const tables = document.querySelectorAll('table');
    tables.forEach((table, tableIndex) => {
      try {
        let markdown = '\n\n### TABLE_START ###\n';  // Explicit start marker
        const rows = table.querySelectorAll('tr');

        rows.forEach((row, rowIndex) => {
          const cells = row.querySelectorAll('th, td');
          const cellTexts = Array.from(cells).map(cell => {
            const text = cell.textContent?.trim() || '';
            // Normalize whitespace within cells
            return text.replace(/\s+/g, ' ');
          });

          markdown += '| ' + cellTexts.join(' | ') + ' |\n';

          // Add separator after header row
          if (rowIndex === 0 && rows.length > 1 && cellTexts.length > 0) {
            markdown += '| ' + cellTexts.map(() => '---').join(' | ') + ' |\n';
          }
        });

        markdown += '### TABLE_END ###\n\n';  // Explicit end marker

        // Replace table with markdown text node
        const textNode = document.createTextNode(markdown);
        table.parentNode?.replaceChild(textNode, table);

        console.log(`Converted table ${tableIndex} to markdown with ${rows.length} rows`);
      } catch (err) {
        console.warn(`Failed to convert table to markdown:`, err);
      }
    });

    // Add section markers before paragraphs and significant divs to improve chunking boundaries
    // Only target elements within the main content area to avoid navigation/breadcrumbs
    try {
      // First, find the main content container (common patterns across OSC pages)
      const mainContent = document.querySelector('#content, #main-content, .main-content, article, [role="main"]') || document.body;

      const sections = mainContent.querySelectorAll('p, div');
      let sectionCount = 0;
      sections.forEach((section) => {
        // Skip if already processed (has marker)
        if (section.previousSibling && section.previousSibling.nodeType === Node.TEXT_NODE) {
          const prevText = section.previousSibling.textContent || '';
          if (prevText.includes('### SECTION ###')) {
            return;
          }
        }

        const text = section.textContent?.trim() || '';

        // Only mark if element has significant text content (> 100 chars)
        if (text.length > 100) {
          const marker = '\n\n### SECTION ###\n\n';
          const textNode = document.createTextNode(marker);
          section.parentNode?.insertBefore(textNode, section);
          sectionCount++;
        }
      });
      console.log(`Added ${sectionCount} section markers in main content area`);
    } catch (err) {
      console.warn(`Failed to add section markers:`, err);
    }

    // Add markers before toggle/collapsible elements to separate their content
    try {
      const togglers = document.querySelectorAll('div.toggled, div.collapsed, details');
      let togglerCount = 0;
      togglers.forEach((toggler) => {
        // Skip if already processed (has marker)
        if (toggler.previousSibling && toggler.previousSibling.nodeType === Node.TEXT_NODE) {
          const prevText = toggler.previousSibling.textContent || '';
          if (prevText.includes('### TOGGLER:')) {
            return;
          }
        }

        // Try to find a title from preceding toggler header or summary
        let title = 'Section';
        const prevSibling = toggler.previousElementSibling;
        if (prevSibling) {
          const prevTagName = prevSibling.tagName.toLowerCase();
          if (prevTagName === 'h3' && prevSibling.classList.contains('toggler')) {
            title = prevSibling.textContent?.trim() || 'Section';
          } else if (prevTagName === 'summary') {
            title = prevSibling.textContent?.trim() || 'Section';
          }
        }

        const marker = `\n\n### TOGGLER: ${title} ###\n\n`;
        const textNode = document.createTextNode(marker);
        toggler.parentNode?.insertBefore(textNode, toggler);
        togglerCount++;
      });
      console.log(`Added ${togglerCount} toggler markers`);
    } catch (err) {
      console.warn(`Failed to add toggler markers:`, err);
    }

    // Check if the selector is an XPath
    if (selector.startsWith("/")) {
      console.log(`XPath: ${selector}`);
      const elements = document.evaluate(
        selector,
        document,
        null,
        XPathResult.ANY_TYPE,
        null,
      );
      const result = elements.iterateNext();
      return result ? result.textContent || "" : "";
    } else {
      // Handle as a CSS selector
      const el = document.querySelector(selector) as HTMLElement | null;

      if (!el) {
        console.warn(`Selector "${selector}" not found, falling back to body`);
        return document.body?.textContent?.replace(/\s+/g, ' ').trim() || "";
      }

      // Use textContent instead of innerText to capture text in collapsed/collapsible elements
      const rawText = el.textContent || "";

      // Normalize whitespace: replace multiple spaces/newlines/tabs with single space, then trim
      const normalizedText = rawText.replace(/\s+/g, ' ').trim();

      console.log(`Extracted ${normalizedText.length} characters from selector "${selector}"`);

      return normalizedText;
    }
  }, selector);
}

async function waitForXPath(page: Page, xpath: string, timeout: number) {
  await page.waitForFunction(
    (xpath) => {
      const elements = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.ANY_TYPE,
        null,
      );
      return elements.iterateNext() !== null;
    },
    xpath,
    { timeout },
  );
}

function removeUndefinedFromObject(obj: Record<string, any>) {
  Object.keys(obj).forEach(key => {
    if (obj[key] === undefined) {
      delete obj[key];
    }
  });
  return obj;
}
