build:
	buildah build --layers -t docker-registry.osc.edu/osc/crawlee:latest -f Dockerfile .
push:
	docker push docker-registry.osc.edu/osc/crawlee:latest
