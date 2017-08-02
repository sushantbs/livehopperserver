var request = require('superagent');
var config = require('../../config/config.dev.js');

module.exports = {

  getProfile: function (token) {

    request(config.graphUrl)
      
  }
}
