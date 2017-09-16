var express = require("express");
var router = express.Router();
var fetch = require("node-fetch");
var memjs = require("memjs");
var _ = require("lodash");
var Promise = require("es6-promise").Promise;
var devconfig = require("../../../config/config.dev");
var stagingconfig = require("../../../config/config.heroku");

var config = devconfig;

var serviceUrl = `${config.db.endpoint}/api`;

var cacheClient = memjs.Client.create();
var cache = {
    get: key =>
        new Promise((resolve, reject) =>
            cacheClient.get(key, (err, val) => {
                console.log(
                    `CACHEGET: ${key} from cache: ${val}; Error: ${err}`
                );
                return err ? reject(err) : resolve(JSON.parse(val));
            })
        ),
    set: (key, value, expires) =>
        new Promise((resolve, reject) => {
            cacheClient.set(
                key,
                JSON.stringify(value),
                { expires },
                (err, val) => {
                    console.log(
                        `CACHESET: ${key} to cache: ${val}; Error: ${err}`
                    );
                    return err ? reject(err) : resolve(val);
                }
            );
        }),
    delete: key =>
        new Promise((resolve, reject) =>
            cacheClient.delete(
                key,
                (err, val) => (err ? reject(err) : resolve(val))
            )
        )
};

var dataManager = {
    getUser: async email => {
        var userProfile = await cache.get(email);
        if (userProfile) {
            return Promise.resolve(userProfile);
        } else {
            console.log(`getting user details from ${serviceUrl}`);
            return fetch(`${serviceUrl}/user/details?email=${email}`)
                .then(response => response.json())
                .then(respJson => {
                    if (respJson.length) {
                        cache.set(email, respJson[0]);
                        return respJson[0];
                    }

                    return null;
                });
        }
    },
    createUser: async ({ email, name }) => {
        let user = await fetch(`${serviceUrl}/user/add`, {
            headers: {
                "content-type": "application/json",
                accept: "application/json"
            },
            method: "POST",
            body: JSON.stringify({ email, name })
        }).then(response => response.json());

        if (user.length) {
            cache.set(email, user[0]);
            return Promise.resolve(user[0]);
        }

        return Promise.reject(new Error("Could not create the user"));
    }
};

var errorHandler = function(res) {
    return function(err) {
        if (err) {
            console.log(`NETWORK ERROR: ${err}`);
            res.status(500).send(err);
            return;
        }
    };
};
//var cache;
module.exports = router;

var validate = function(req, res, next) {
    let token = req.headers.token;

    if (!token) {
        res.status(500).send("Token not found");
        return;
    }

    cache
        .get(token)
        .then(tokenResponse => {
            if (tokenResponse) {
                return tokenResponse;
            } else {
                return Promise.all([
                    fetch(
                        `https://graph.facebook.com/debug_token?access_token=1074798345983056|O6QWGRy2Sd9YAknhlkvg5qjbuJM&input_token=${token}`
                    ).then(response => response.json()),

                    fetch(
                        `https://graph.facebook.com/me?fields=name,email,picture&access_token=${token}`
                    ).then(response => response.json())
                ]);
            }
        })
        .then(
            response =>
                response instanceof Array
                    ? _.extend(response[0], response[1])
                    : response
        )
        .then(responseJson => {
            let error = responseJson.data && responseJson.data.error;
            if (error) {
                if (error.code === 190) {
                    // Token has expired
                    if (responseJson.cached) {
                        cache.delete(token);
                    }

                    res.status(200).send({ status: "ERROR", error: error });
                }
            }

            // Need to set the proper expiryTime
            if (!responseJson.cached) {
                let currTime = new Date().valueOf();
                console.log(`setting token in cache`);
                cache.set(
                    token,
                    _.extend({ cached: true }, responseJson),
                    Number(responseJson.expiresAt) - Math.ceil(currTime / 1000)
                );
            }

            // Using WeakMaps to avoid memory leaks!
            // Update: Not really needed. You would only need the weakmap if the responseJson
            // object were to store a reference to the req object.
            req.user = new WeakMap();
            req.user.set(req, responseJson);
            next();
        })
        .catch(err => {
            console.log("Token validation error: ", err);
            res.status(500).send(err);
        });
};

router.post("/user/logout", (req, res, next) => {
    let token = req.headers.token;

    if (!token) {
        res.status(500).send("Token not found");
        return;
    }

    cache.delete(token).then(res.send({ success: true }));
});

router.get("/user/profile", validate, (req, res, next) => {
    var oAuthUserObj = req.user.get(req);
    var email = oAuthUserObj.email;

    dataManager
        .getUser(email)
        .then(respJson => {
            if (respJson) {
                return respJson;
            } else {
                return dataManager.createUser(oAuthUserObj);
            }
        })
        .then(respJson => {
            res.send(respJson);
        })
        .catch(errorHandler(res));
});

router.get("/user/fullprofile", validate, (req, res, next) => {
    var oAuthUserObj = req.user.get(req);
    var email = oAuthUserObj.email;

    dataManager
        .getUser(email)
        .then(respJson =>
            Promise.all([
                Promise.resolve(respJson),

                async () => {
                    await fetch(`${serviceUrl}/user/likedartists`);
                },

                async () => {
                    await fetch(`${serviceUrl}/user/likedhosts`);
                },

                async () => {
                    await fetch(`${serviceUrl}/user/attending`);
                }
            ])
        )
        .then(detailedProfileArray => {
            res.send(detailedProfileArray);
        })
        .catch(errorHandler(res));
});

router.post("/user/feed", validate, (req, res, next) => {
    var oAuthUserObj = req.user.get(req),
        email = oAuthUserObj.email;

    cache
        .get(email)
        .then(userProfile => {
            console.log(userProfile);
            if (userProfile) {
                fetch(`${serviceUrl}/user/feed`, {
                    method: "POST",
                    body: JSON.stringify({
                        personId: userProfile.person._id
                    }),
                    headers: {
                        "Content-Type": "application/json"
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

router.get("/gig/details", validate, (req, res, next) => {
    var oAuthUserObj = req.user.get(req),
        email = oAuthUserObj.email;

    cache.get(email).then(userProfile => {
        return res.send({ imFollowing: true, myStatus: "yes" });
    });
});

router.post("/gig/attending", validate, (req, res, next) => {});

router.post("/gig/rate", validate, (req, res, next) => {});

router.post("/artist/like", validate, (req, res, next) => {});

router.post("/host/like", validate, (req, res, next) => {});
