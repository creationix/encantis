.PHONY: test clean

test:
	$(MAKE) -C grammar test

clean:
	$(MAKE) -C grammar clean