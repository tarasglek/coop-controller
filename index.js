var SunCalc = require("suncalc");
var Promise = require("bluebird");
const http = require('http')
var url = require('url');
var fs = Promise.promisifyAll(require("fs"));

const doorGpioPin = 21;
const waterGpioPin = 20;

var actions = {"open":"0", "close":"1"};
var pinValues = {"0":"open", "1":"close"};
var gOverride = null;

function pinDir(pinNumber) {
  return "/sys/class/gpio/gpio" + pinNumber + "/";
}

function pinValueFile(pinNumber) {
  return pinDir(pinNumber) + "value";
}

function pinDirectionFile(pinNumber) {
  return pinDir(pinNumber) + "direction";
}

function readPin(pinNumber) {
  return (
    fs.readFileAsync(pinDirectionFile(pinNumber)).catch(e => {
      if (e.code === 'ENOENT') {
        return setupPin(pinNumber).then(() => fs.readFileAsync(pinDirectionFile(pinNumber)));
      } else {
        console.error("readFileAsync else",e, e.code);
        throw e;
      }
    }).then(x => {
      x = x.toString().trim();
      if (x == "out") {
        return Promise.resolve();
      } else {
        return setDirection(pinNumber, "out");
      }
    }).then(_ => fs.readFileAsync(pinValueFile(pinNumber))).
      then(value => value.toString().trim())
  )
}

function setupPin(pinNumber) {
  const pinExport = "/sys/class/gpio/export";
  console.error(pinExport, "adding pin " + pinNumber);
  return fs.writeFileAsync(pinExport, pinNumber).delay(1000)
}


function setDirection(pinNumber, direction) {
  var file = pinDirectionFile(pinNumber)
  return fs.writeFileAsync(file, `${direction}\n`).then(x=>console.log(`${direction} => ${file}`));
}

function getOpenCloseTimes() {
  var times = SunCalc.getTimes(new Date(), 37.4852, -122.2364)
  var sunRiseTime = times.sunrise.getTime()
  var hour = 60 * 60 * 1000
  return {
      open: new Date(sunRiseTime + hour),
      close: times.sunset
    }
}

function setPin(pinNumber, value) {
  return (
    readPin(pinNumber).
      then(oldValue => {
        if (oldValue == value)
          return //console.error(pinValue, "already set to " + actionPinValue + ". " + action + ". Nothing to do");
        return fs.writeFileAsync(pinValueFile(pinNumber), value).
          then(_ => console.error(pinValueFile(pinNumber), oldValue + " => " + value, new Date()))
      }).
      catch(e => console.error(pinValueFile(pinNumber), " failed to set to " + actions[value],e, e.stack))
  )
}

function ensureDoor(openOrClose) {
  return readPin(doorGpioPin).then(doorValue => {
    if (pinValues[doorValue] == openOrClose) {
      // pin is already at desired value
      return Promise.resolve()
    } else {
      console.error(openOrClose, "open", openOrClose == "open")
      if (openOrClose == "open") {
        setPin(waterGpioPin, actions['open']).delay(1000*60).then(_ => setPin(waterGpioPin, actions['close'])).catch(err => console.error(err.stack))
      }
      return setPin(doorGpioPin, actions[openOrClose])
    }
  })
}

function loop() {
  var times = getOpenCloseTimes()
  var now = new Date();
  var action = (now.getTime() > times.open.getTime() && now.getTime() < times.close.getTime()) ?
    "open" : "close";
  if (gOverride)
    action = gOverride;
  ensureDoor(action).delay(1000).catch(err => console.error(err.stack)).then(loop)
}


function server() {
  const requestHandler = (request, response) => {
    var parts = url.parse(request.url, false);
    if (parts.pathname != "/") {
      response.statusCode = 404;
      console.error("404", request.url)
      return response.end("No " + parts.pathname);
    }
    if (parts.query) {
      var firstPromise = Promise.resolve(0);
      var query = parts.query.split('=')[0]
      if (query == "auto") {
        gOverride = null;
      } else if (query in actions) {
        gOverride = query;
        console.error(`action: ${query}`)
        firstPromise = ensureDoor(query).catch(e => {
              response.statusCode = 500;
              response.end(e.toString())
            }).delay(1000)
      }
      return firstPromise.then(x => {
        response.writeHead(302, {'Location': '/' });
        response.end();
      })
    }
    readPin(doorGpioPin).then(state => {
      var times = getOpenCloseTimes()
      var autoString = gOverride ? "manual" : "auto"
      var stateString = pinValues[state]
      return response.end(
      `<html>
      <head>
      <title>coop: ${stateString}</title>
      <meta name="viewport" content="width=device-width; initial-scale=1.0; maximum-scale=1.0; user-scalable=0;"/>
      <style>
button {
    width:100%;
    height:20%;
}
.${stateString},
.${autoString}
{ font-weight: bold;
  text-transform: uppercase;
   }
</style>
      </head>
      <body>
      ${stateString} (${autoString})<br>
      <div class=open>open@${times.open.toLocaleTimeString()}</div>
      <div class=close>close@${times.close.toLocaleTimeString()}</div>
      <form>
      <button name=open class=open>open</button>
      <button name=close class=close>close</button>
      <button name=auto class=auto>auto</button>
      </form>
      </body>
      </html>`
      )
    }
      )
  }


  const server = http.createServer(requestHandler)

  function listen(port) {
    server.listen(port, (err) => {
      if (err) {
        console.log('failed to listen on port ' + port, err)
        if (port == 80)
          listen(8080)
        return
      }

      console.log(`server is listening on ${port}`)
    })
  }
  listen(80)
}

console.error("starting coop controller");
server();
loop();
