var express = require('express');
var router = express.Router();
var request = require('superagent');
var fetch = require('node-fetch');
var memjs = require('memjs');
var _ = require('lodash');
var Promise = require('es6-promise').Promise;
var config = require('../../../config/config.heroku');
var serviceUrl = `${config.db.endpoint}/api`;

var cacheClient = memjs.Client.create();
var cache = {
  get: key => (new Promise((resolve, reject) => {
    //console.log(`Getting ${key} from cache`);
    cacheClient.get(key, (err, val) => {
      console.log(err, val);
      return (err ? reject(err) : resolve(val))
    });
  })),
  set: (key, value, expires) => (new Promise((resolve, reject) => {
    //console.log(`Setting ${key} to cache with value ${value}`);
    cacheClient.set(key, value, {expires}, (err, val) => {
      console.log(arguments);
      return (err ? reject(err) : resolve(val)));
    });
  })),
  delete: key => (new Promise((resolve, reject) => {
    cacheClient.delete(key, (err, val) => (err ? reject(err) : resolve(val)));
  }))
}

var errorHandler = function (res) {
  return function (err) {
    if (err) {
      res.status(500).send(err);
      return;
    }
  }
}
//var cache;
module.exports = router;

var validate =  function (req, res, next) {

  let token = req.headers.token;

  if (!token) {
    res.status(500).send('Token not found');
    return;
  }

  cache
    .get(token)
    .then((tokenResponse) => {
      if (tokenResponse) {
        return tokenResponse;
      } else {
        return Promise.all([
          new Promise((resolve, reject) => {
            return fetch('https://graph.facebook.com/debug_token?access_token=1074798345983056|O6QWGRy2Sd9YAknhlkvg5qjbuJM&input_token=' + token)
              .then(response => response.json())
              .then(respJson => resolve(respJson))
              .catch(err => reject(err));
            })
          ,
          new Promise((resolve, reject) => {
            return fetch('https://graph.facebook.com/me?fields=email&access_token=' + token)
              .then(response => response.json())
              .then(respJson => resolve(respJson))
              .catch(err => reject(err));
            })
        ])
      }
    })
    .then((response) => ((response instanceof Array) ? _.extend(response[0], response[1]) : response))
    .then((responseJson) => {

      let error = responseJson.data && responseJson.data.error;
      if (error) {
        if (error.code === 190) {
          // Token has expired
          if (responseJson.cached) {
            cache.delete(token);
          }

          res.status(200).send({status: 'ERROR', error: error});
        }
      }

      // Need to set the proper expiryTime
      if (!responseJson.cached) {
        let currTime = new Date().valueOf();
        cache.set(
          token,
          _.extend({cached: true}, responseJson),
          (Number(responseJson.expiresAt) - Math.ceil(currTime / 1000))
        );
      }

      // Using WeakMaps to avoid memory leaks!
      // Update: Not really needed. You would only need the weakmap if the responseJson
      // object were to store a reference to the req object.
      req.user = new WeakMap();
      req.user.set(req, responseJson);
      next();
    })
    .catch((err) => {
      console.log("Token validation error: ", err);
      res.status(500).send(err);
    });
};

router.get('/user/profile', validate, (req, res, next) => {

  var oAuthUserObj = req.user.get(req);
  var emailId = oAuthUserObj.email;

  fetch(serviceUrl + '/user?emailId=' + emailId)
    .then(response => response.json())
    .then(respJson => {
      cache.set(emailId, respJson[0]);
      res.send(respJson);
    })
    .catch(errorHandler(res))
});

router.get('/user/feed', validate, (req, res, next) => {

  var oAuthUserObj = req.user.get(req),
    emailId = oAuthUserObj.email;

  cache
    .get(emailId)
    .then((userProfile) => {
      console.log(userProfile);
      if (userProfile) {
        fetch(serviceUrl + '/data/user/feed',
          {
            method: 'POST',
            body: JSON.stringify({
              personId: userProfile.person._id
            }),
            headers: {
              'Content-Type': 'application/json'
            }
          })
          .then(response => response.json())
          .then(respJson => res.send(respJson))
          .catch(errorHandler(res));

      } else {
        res.status(403).send();
      }
    })
    .catch(errorHandler(res));
});

router.get('/gig/details', validate, (req, res, next) => {
  var oAuthUserObj = req.user.get(req),
    emailId = oAuthUserObj.email;

  console.log(emailId);
  cache.get(emailId)
    .then((userProfile) => {
      console.log(userProfile);
      return res.send({imFollowing: true, myStatus: 'yes'})
    })
});
