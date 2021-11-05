.PHONY: test clean

test: EncantisParser.class test-types.ws
	cat test-types.ws |\
	xargs -I{} sh -c 'echo -n "\033[0;36m{}\033[0m 🪄  \033[0;35m" && echo "{}" | java org.antlr.v4.gui.TestRig Encantis type -tree && echo "\033[0m"'

clean:
	rm -f *.class *.test *.interp *.java *.tokens

EncantisParser.java: Encantis.g4
	java -jar /usr/local/lib/antlr-4.9.2-complete.jar Encantis.g4

EncantisParser.class: EncantisParser.java
	javac Encantis*.java
