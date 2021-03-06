var http = require('http');
var https = require('https');
var url = require('url');
var extend = require('extend');
var logger = require('./logger');

var cache = {};
var listeners = [];
var newUrls;
var TIMEOUT = 10000;
var MAX_RULES_LEN = 1024 * 64;
var MAX_INTERVAL = 1000 * 30;
var MIN_INTERVAL = 1000 * 10;
var EEXCEED = 'EEXCEED';
var queue = [];
var queueTimer;

function getInterval(time) {
  var len = Object.keys(cache).length || 1;
  var interval = Math.max(MIN_INTERVAL, Math.ceil(MAX_INTERVAL / len));
  var minTime = interval - (time > 0 ? time : 0);
  return Math.max(minTime, 1000);
}

function triggerChange() {
  if (!newUrls) {
    newUrls = {};
    listeners.forEach(function(l) {
      l();
    });
    Object.keys(newUrls).forEach(function(url) {
      newUrls[url] = cache[url];
    });
    cache = newUrls;
    newUrls = null;
  }
}

function parseOptions(options) {
  var fullUrl = options.url || options.uri || options;
  if (typeof fullUrl === 'string') {
    options = extend(options, url.parse(fullUrl));
  }
  var maxLength = options.maxLength;
  if (!(maxLength > 0)) {
    options.maxLength = 0;
  }
  options.agent = false;
  options.rejectUnauthorized = false;
  return options;
}

function request(options, callback) {
  options = parseOptions(options);
  var isHttps = options.protocol === 'https:';
  var httpModule = isHttps ? https : http;
  var done, timer, res;
  var body = '';
  var callbackHandler = function(err) {
    clearTimeout(timer);
    err && client.abort();
    if (!done) {
      done = true;
      callback(err, body, res || '');
    }
  };
  var addTimeout = function() {
    clearTimeout(timer);
    timer = setTimeout(function() {
      callbackHandler(new Error('Timeout'));
    }, TIMEOUT);
  };
  addTimeout();
  var maxLength = options.maxLength;
  var client = httpModule.get(options, function(r) {
    res = r;
    res.on('error', callbackHandler);
    res.setEncoding('utf8');
    res.on('data', function(data) {
      body += data;
      addTimeout();
      if (maxLength && body.length > maxLength) {
        var err;
        if (!options.ignoreExceedError) {
          err = new Error('The response body exceeded length limit');
          err.code = EEXCEED;
        }
        callbackHandler(err);
      }
    });
    res.on('end', callbackHandler);
  });
  client.on('error', callbackHandler);
  client.end();
  return client;
}

exports.request = request;

function addQueue(url, consumeTime) {
  if (cache[url] && queue.indexOf(url) === -1) {
    queue.push(url);
  }
  var data;
  while(!queueTimer && !data) {
    url = queue.shift();
    if (!url) {
      return;
    }
    data = cache[url];
    if (data) {
      queueTimer = setTimeout(function() {
        queueTimer = null;
        updateBody(url, addQueue);
      }, getInterval(consumeTime));
      return;
    }
  }
}

function updateBody(url, callback, init) {
  var data = cache[url];
  if (!data) {
    return callback && callback();
  }
  var now = Date.now();
  request({
    url: url,
    maxLength: MAX_RULES_LEN,
    ignoreExceedError: true
  }, function(err, body, res) {
    data = cache[url];
    callback && callback(url, Date.now() - now);
    if (!data) {
      return;
    }
    if (!err && res.statusCode !== 200) {
      err = new Error('Response ' + res.statusCode);
    }
    if (err) {
      logger.error(url, err.message);
      if (init) {
        updateBody(url);
        return;
      }
    }
    addQueue(url);
    body = body && body.trim();
    if (err || data.body === body) {
      return;
    }
    data.body = body;
    triggerChange();
  });
  return true;
}

exports.addChangeListener = function(l) {
  listeners.push(l);
};

exports.add = function(url) {
  var data = cache[url];
  if (!data) {
    cache[url] = data = {body: ''};
    updateBody(url, null, true);
  }
  if (newUrls) {
    newUrls[url] = 1;
  }
  return data.body;
};

exports.clean = function() {
  if (!newUrls && Object.keys(cache).length) {
    triggerChange();
  }
};
