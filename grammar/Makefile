.PHONY: test clean

test: EncantisParser.js test.js node_modules/antlr4/package.json
	node test.js

clean:
	rm -rf Encantis*.js *.class *.test *.interp *.java *.tokens package-lock.json .antlr node_modules

node_modules/antlr4/package.json: package.json
	npm i

EncantisParser.js: Encantis.g4
	java -jar /usr/local/lib/antlr-4.9.2-complete.jar -visitor -Dlanguage=JavaScript Encantis.g4
