test: EncantisParser.class test-types.ws
	cat test-types.ws |\
	xargs -I{} sh -c 'echo "\n{}" && echo "{}" | java org.antlr.v4.gui.TestRig Encantis type -tree' |\
	tee test

EncantisParser.java: Encantis.g4
	java -jar /usr/local/lib/antlr-4.9.2-complete.jar Encantis.g4

EncantisParser.class: EncantisParser.java
	javac Encantis*.java
