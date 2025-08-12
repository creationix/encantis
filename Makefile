.PHONY: test clean

test:
	$(MAKE) -C examples test

clean:
	# No build artifacts to clean