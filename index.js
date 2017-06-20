var Promise     = require('bluebird')
  , config      = require('config-url')
  , winston     = require('winston')
  , crypto      = require('crypto')
  , uuid        = require('node-uuid')
  , urljoin     = require('url-join')
  , cache_man   = require('cache-manager')
  , cache_redis = require('cache-manager-redis-store')
  , Redlock     = require('redlock')
  , redis       = require('redis')
  , rp          = require('request-promise')
  , retry       = require('bluebird-retry')
  ;

var cache_mem = cache_man.caching({ store : 'memory', ttl : 5/*seconds*/ });

// todo [akamel] not all users of sdk need to connect to redis (if only used for key_gen)
var cache_red = cache_man.caching({
    store             : cache_redis
  , host              : config.get('make.redis.host')
  , port              : config.get('make.redis.port')
  , auth_pass         : config.get('make.redis.password')
  , db                : config.get('make.redis.db')
  // , ttl     : 600
  , promiseDependency : Promise
});

var cache = cache_man.multiCaching([ cache_mem, cache_red ]);

var redis_client = redis.createClient({
    host              : config.get('make.redis.host')
  , port              : config.get('make.redis.port')
  , auth_pass         : config.get('make.redis.password')
  , db                : config.get('make.redis.db')
});

var redlock = new Redlock([redis_client], { retryCount : 0 });

let make_url = urljoin(config.getUrl('make'), 'make');

function key_gen(remote, sha, options = {}) {
  let { single_use } = options;

  let key = `${remote}#${sha}`;

  if (single_use) {
    let uid = uuid.v4();

    key += `+${uid}`;
  }

  let hash = crypto.createHmac('sha256', '').update(key).digest('hex')

  return { key, hash };
}

function set(result, options) {
  return cache.set(result.hash, result, options);
}

function del(hash) {
  return cache.del(hash);
}

function get(hash) {
  // return cache
  //         .wrap(hash, () => {
  //           return undefined;
  //         });
  return cache_mem
          .get(hash)
          .then((result) => {
            if (!result) {
              return cache_red.get(hash).then((result) => { cache_mem.set(hash, result); return result; });
            }

            return result;
          })
          ;
}

function make(remote, sha, options = {}) {
  let single_use = !!options.blob;

  let { blob, timeout } = options;

  let { key, hash } = key_gen(remote, sha, { single_use });

  if (!blob) {
    return get(hash)
            .then((result) => {
              if (result) {
                return result;
              }

              return make_new(remote, sha, options)
                      .then((response) => {
                        let { statusCode, body } = response;

                        if (statusCode == 200) {
                          winston.info('found container', key, hash);
                          return body;
                        }

                        // if we are building already, wait and try to get
                        if (statusCode == 423) {
                          winston.info('build in progress', key, hash);
                          // todo [akamel] ensure that the lock is being renewed or active
                          return retry(
                                    () => {
                                      winston.info('waiting for build...', key, hash);
                                      return get(hash)
                                              .then((r) => {
                                                if (!r) { throw new Error('make timeout') };

                                                return r;
                                              })
                                    }
                                  , { interval : 500, timeout }
                                )
                                .tap((result) => {
                                  winston.info('build complete', key, hash);
                                });
                        }

                        throw new Error(body);
                      });
            });
  } else {
    return make_new(remote, sha, options)
            .then((response) => {
              return response.body;
            });
  }
}

function make_new(remote, sha, options = {}) {
  let { blob, filename, token, bearer, cache } = options;

  let json = { remote, sha, blob, filename, token, cache };

  return rp.post(make_url, { json, headers : { 'authorization' : bearer }, simple : false, resolveWithFullResponse : true }).promise();
}

const ttl = 5 * 1000;
// const ttl = 5000 * 1000;

function lock(hash) {
  return redlock.lock(`lock:${hash}`, ttl);
}

function extend(lock) {
  return lock.extend(ttl);
}

function unlock(lock) {
  return lock.unlock();
}

module.exports = {
    make
  , key   : key_gen
  , set
  , get
  , del
  , lock
  , extend
  , unlock
};
