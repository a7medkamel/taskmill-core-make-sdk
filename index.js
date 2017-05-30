var config    = require('config-url')
  , winston   = require('winston')
  , redis     = require('redis')
  , urljoin   = require('url-join')
  , rp        = require('request-promise')
  ;

Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);

var client = redis.createClient(config.get('make.redis'));

let make_url = urljoin(config.getUrl('make'), 'make');

function make(remote, options = {}) {
  let sha         = options.branch
    , single_use  = options.single_use
    , key         = `${remote}#${sha}`
    ;

  // todo [akamel] single_use
  if (single_use) {
    key = `${key}+foo`
  }

  return client
           .getAsync(key)
           .then((run_url) => {
             if (!run_url) {
              //  return rp.post(make_url, { json : { remote, sha } });
              return {};
             }

             return {
               run_url
             };
           });
}

module.exports = {
  make  : make
};
