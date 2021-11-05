.PHONY: test clean

test: EncantisParser.js test.js
	node test.js

clean:
	rm -f Encantis*.js *.class *.test *.interp *.java *.tokens package-lock.json

EncantisParser.js: Encantis.g4
	java -jar /usr/local/lib/antlr-4.9.2-complete.jar -visitor -Dlanguage=JavaScript Encantis.g4
