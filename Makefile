
JS_FILES =	$(wildcard *.js) \
		$(wildcard */*.js)

check:
	jshint $(JS_FILES)

