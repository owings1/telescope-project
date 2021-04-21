// Serial device command HTTP service

const fs         = require('fs')
const merge      = require('merge')
const bodyParser = require('body-parser')
const express    = require('express')
const path       = require('path')
const prom       = require('prom-client')
const showdown   = require('showdown')
const Util       = require('./util')

const MockBinding = require('@serialport/binding-mock')
const SerPortFull = require('serialport')
const SerPortMock = require('@serialport/stream')
const Readline    = require('@serialport/parser-readline')

const DEG_NULL = 1000

prom.collectDefaultMetrics()

const DeviceCodes = {
     0: 'OK',
     1: 'Device closed',
     2: 'Command timeout',
     3:  'Flush error',
    40: 'Missing : before command',
    44: 'Invalid command',
    45: 'Invalid motorId',
    46: 'Invalid direction',
    47: 'Invalid steps/degrees',
    48: 'Invalid speed/acceleration',
    49: 'Invalid other parameter',
    50: 'Orientation unavailable',
    51: 'Limits unavailable'
}

const Gpio = require('./gpio')

class App {

    defaults(env) {
        env = env || process.env
        return {
            gaugerPath     : env.GAUGER_PORT,
            gaugerBaudRate : +env.GAUGER_BAUD_RATE || 9600,
            mock           : !!env.MOCK,
            port           : env.HTTP_PORT || 8080,
            quiet          : !!env.QUIET,
            openDelay      : +env.OPEN_DELAY || 2000,
            workerDelay    : +env.WORKER_DELAY || 100,

            gpioEnabled        : !!env.GPIO_ENABLED,
            pinControllerReset : +env.PIN_CONTROLLER_RESET || 37,
            pinControllerStop  : +env.PIN_CONTROLLER_STOP || 35,
            pinControllerReady : +env.PIN_CONTROLLER_READY || 38,
            pinGaugerReset     : +env.PIN_GAGUER_RESET || 36,
            // how long to wait after reset to reopen device
            resetDelay     : +env.RESET_DELAY || 5000,
            commandTimeout : +env.COMMAND_TIMEOUT || 5000
        }
    }

    constructor(opts, env) {

        this.opts = merge(this.defaults(env), opts)

        this.gaugerJobs         = {}
        this.gaugerQueue        = []
        this.gaugerBusy         = false
        this.gaugerWorkerHandle = null
        this.isGaugerConnected  = false
        
        this.app        = express()
        this.httpServer = null

        this.clearStatus()
        this.clearGauges()
        this.initApp(this.app)
    }

    clearStatus() {
        this.position      = [null, null]
        this.limitsEnabled = [null, null]
    }

    clearGauges() {
        this.gpsCoords = [null, null]
        this.magHeading = null
        this.declinationAngle = null
        this.orientation   = [null, null, null]
        this.isOrientationCalibrated = null
    }

    async status() {
        const controllerState = this.gpio ? (await this.gpio.getControllerState()) : null
        return {
            controllerState,
            position                  : this.position,
            orientation               : this.orientation,
            limitsEnabled             : this.limitsEnabled,
            isGaugerConnected         : this.isGaugerConnected,
            isOrientationCalibrated   : this.isOrientationCalibrated,
            gaugerConnectedStatus     : this.isGaugerConnected ? 'Connected' : 'Disconnected',
            gpsCoords                 : this.gpsCoords,
            magHeading                : this.magHeading,
            declinationAngle          : this.declinationAngle
        }
    }

    listen() {
        return new Promise((resolve, reject) => {
            try {
                this.initGpio().then(() => {
                    this.httpServer = this.app.listen(this.opts.port, () => {
                        this.log('Listening on', this.httpServer.address())
                        this.openGauger().then(resolve).catch(reject)
                    })
                }).catch(reject)
            } catch (err) {
                reject(err)
            }
        })
    }

    async openGauger() {
        this.closeGauger()
        this.log('Opening gauger', this.opts.gaugerPath)
        this.gauger = this.createDevice(this.opts.gaugerPath, this.opts.gaugerBaudRate)
        await new Promise((resolve, reject) => {
            this.gauger.open(err => {
                if (err) {
                    reject(err)
                    return
                }
                this.isGaugerConnected = true
                this.log('Gauger opened, delaying', this.opts.openDelay, 'ms')
                this.gaugerParser = this.gauger.pipe(new Readline)
                setTimeout(() => {
                    try {
                        this.gauger.flush()
                        this.initGaugerWorker()
                        this.gaugerParser.on('data', data => {
                            try {
                                if (data.indexOf('ACK:') == 0) {
                                    this.handleGaugerAckData(data)
                                } else {
                                    this.handleGaugeData(data)
                                }
                            } catch (err) {
                                this.error('Exception while handling response data', err)
                            }
                            
                        })
                        this.log('Setting gauger to streaming mode')
                        this.gaugerCommand(':71 2;\n').then(res => {
                            if (res.status != 0) {
                                this.error('Failed to set gauger to streaming mode', res)
                                return
                            }
                            this.log('Gauger acknowledges streaming mode')
                        })
                        resolve()
                    } catch (err) {
                        reject(err)
                    }
                }, this.opts.openDelay)
            })
        })
    }

    handleGaugerAckData(data) {
        const [ack, id, resText] = data.split(':')
        if (this.gaugerJobs[id]) {
            this.log('Gauger ACK job', {id, resText})
            try {
                const status = parseInt(resText.substring(1, 3))
                var res = {
                    status,
                    message : DeviceCodes[status],
                    body    : resText.substring(4),
                    raw     : resText
                }
            } catch (error) {
                var res = {error}
            }
            this.gaugerJobs[id].handler(res)
        } else {
            this.log('Unknown gauger job ACKd', {id, resText})
        }
    }

    handleGaugeData(data) {
        const [module, text] = data.split(':')
        const values = (text || '').split('|')
        const floats = Util.floats(values)
        switch (module) {
            case 'GPS':
                this.gpsCoords = floats.map(v => v == DEG_NULL ? null : v)
                break
            case 'MAG':
                this.magHeading = floats[0] == DEG_NULL ? null : floats[0]
                this.declinationAngle = floats[4] == DEG_NULL ? null : floats[4]
                break
            case 'ORI':
                // x|y|z|cal_system|cal_gyro|cal_accel|cal_mag|isCalibrated
                this.orientation = floats.slice(0, 3).map(v => v == DEG_NULL ? null : v)
                this.isOrientationCalibrated = values[7] == 'T'
                break
            case 'MCC':
                // motor controller status
                this.position = [
                    floats[0] == DEG_NULL ? null : floats[0],
                    floats[1] == DEG_NULL ? null : floats[1]
                ]
                this.limitsEnabled = [
                    values[2] == 'T',
                    values[3] == 'T'
                ]
                break
            case 'MOD':
                // names the modules available
                break
            default:
                this.log('Unknown module', module)
                break
        }
    }

    closeGauger() {
        if (this.gauger) {
            this.log('Closing gauger')
            this.gauger.close()
            this.gauger = null
        }
        this.isGaugerConnected = false
        this.drainGaugerQueue()
        
        this.clearStatus()
        this.stopGaugerWorker()
    }

    drainGaugerQueue() {
        this.gaugerJobs = {}
        this.gaugerQueue = []
    }

    close() {
        return new Promise(resolve => {
            this.log('Shutting down')
            //this.closeController()
            this.closeGauger()
            if (this.httpServer) {
                this.httpServer.close()
            }
            resolve()
        })
    }

    gaugerLoop() {
        if (this.gaugerBusy) {
            return
        }

        if (!this.gaugerQueue.length) {
            // TODO: get controller position
            return   
        }

        this.gaugerBusy = true

        const {id, body, handler} = this.gaugerQueue.pop()
        this.gaugerJobs[id] = {
            handler: res => {
                this.gaugerBusy = false
                if (handler) {
                    handler(res)
                }
            }
        }
        this.gauger.write(Buffer.from(this.opts.mock ? body : body.trim()))
    }

    gaugerCommand(body, params = {}) {
        const id = this._newGaugerJobId()
        body = ':' + id + body
        return new Promise((resolve, reject) => {
            this.log('Enqueuing gauger command', body.trim())
            this.gaugerQueue.unshift({isSystem: false, ...params, body, id, handler: resolve})
        })
    }

    _newGaugerJobId() {
        if (!this._gid || this._gid > 2 * 1000 * 1000 * 1000) {
            this._gid = 0
        }
        return ++this._gid
    }

    initGaugerWorker() {
        this.log('Initializing gauger worker to run every', this.opts.workerDelay, 'ms')
        this.stopGaugerWorker()
        this.gaugerWorkerHandle = setInterval(() => this.gaugerLoop(), this.opts.workerDelay)
    }

    stopGaugerWorker() {
        clearInterval(this.gaugerWorkerHandle)
        this.gaugerBusy = false
    }

    initApp(app) {

        app.set('view engine', 'ejs')
        app.set('views', __dirname + '/views')

        app.use('/static', express.static(__dirname + '/static'))

        app.get('/', (req, res) => {
            this.status().then(status => {
                res.render('index', {
                    title: 'MoonUnit',
                    status
                })
            })
        })

        app.get('/status', (req, res) => {
            this.status().then(status => res.status(200).json({status}))
        })

        app.post('/controller/command/sync', bodyParser.json(), (req, res) => {
            if (!req.body.command) {
                res.status(400).json({error: 'missing command'})
                return
            }
            try {
                this.gpio.isControllerReady().then(isReady => {
                    if (!isReady) {
                        res.status(503).json({error: 'not ready', isReady})
                        return
                    }
                    //this.controllerCommand(req.body.command)
                    this.gaugerCommand(req.body.command)
                        .then(response => res.status(200).json({response}))
                        .catch(error => {
                            this.error(error)
                            res.status(500).json({error})
                        })
                }).catch(error => {
                    this.error(error)
                    res.status(500).json({error})
                })
            } catch (error) {
                this.error(error)
                res.status(500).json({error})
            }
        })

        app.post('/gauger/command/sync', (req, res) => {
            if (!req.body.command) {
                res.status(400).json({error: 'missing command'})
                return
            }
            try {
                this.gaugerCommand(req.body.command)
                    .then(response => res.status(200).json({response}))
                    .catch(error => {
                        this.error(error)
                        res.status(500).json({error})
                    })
            } catch (error) {
                this.error(error)
                res.status(500).json({error})
            }
        })

        app.post('/gauger/disconnect', (req, res) => {
            this.closeGauger()
            this.status().then(status => {
                res.status(200).json({message: 'Device disconnected', status})
            })
        })

        app.post('/gauger/connect', (req, res) => {
            if (this.isGaugerConnected) {
                res.status(400).json({message: 'Device already connected'})
                return
            }
            this.openGauger().then(() => {
                this.status().then(status => {
                    res.status(200).json({message: 'Device connected', status})
                })
            }).catch(error => {
                res.status(500).json({error})
            })
        })

        app.get('/controller/gpio/state', (req, res) => {
            if (!this.opts.gpioEnabled) {
                res.status(400).json({error: 'gpio not enabled'})
                return
            }
            this.gpio.getControllerState().then(state =>
                res.status(200).json({state})
            ).catch(error => {
                this.error(error)
                res.status(500).json({error})
            })
        })

        app.post('/controller/gpio/reset', (req, res) => {
            if (!this.opts.gpioEnabled) {
                res.status(400).json({error: 'gpio not enabled'})
                return
            }
            this.closeController()
            this.log('Sending reset')
            this.gpio.sendControllerReset().then(() => {
                res.status(200).json({message: 'reset sent'})
                this.log('Reset sent, delaying', this.opts.resetDelay, 'to reopen')
                setTimeout(() => {
                    this.openController().catch(err => this.error(err))
                }, this.opts.resetDelay)
            }).catch(error => {
                this.error(error)
                res.status(500).json({error})
            })
        })

        app.post('/controller/gpio/stop', (req, res) => {
            if (!this.opts.gpioEnabled) {
                res.status(400).json({error: 'gpio not enabled'})
                return
            }
            this.gpio.sendControllerStop().then(() => {
                res.status(200).json({message: 'stop sent'})
            }).catch(error => {
                this.error(error)
                res.status(500).json({error})
            })
        })

        app.get('/metrics', (req, res) => {
            res.setHeader('Content-Type', prom.register.contentType)
            prom.register.metrics().then(metrics => res.writeHead(200).end(metrics))
        })

        app.get('/doc/:filename', (req, res) => {
            const file = path.resolve(__dirname, '../doc', path.basename(req.params.filename) + '.md')
            fs.readFile(file, 'utf-8', (error, text) => {
                if (error) {
                    if (error.code == 'ENOENT') {
                        res.status(404)
                    } else {
                        res.status(400)
                    }
                    res.json({error})
                    return
                }
                const converter = new showdown.Converter({
                    tables: true
                })
                const html = converter.makeHtml(text)
                res.render('doc', {html})
            })
        })

        app.use((req, res) => res.status(404).json({error: 'not found'}))
    }

    createDevice(devicePath, baudRate) {
        var SerialPort = SerPortFull
        if (this.opts.mock) {
            SerPortMock.Binding = MockBinding
            var SerialPort = SerPortMock
            // TODO: mock response
            //  see: https://serialport.io/docs/api-binding-mock
            //  see: https://github.com/serialport/node-serialport/blob/master/packages/binding-mock/lib/index.js
            MockBinding.createPort(devicePath, {echo: true, readyData: []})
        }
        return new SerialPort(devicePath, {baudRate, autoOpen: false})
    }

    getPositionJob() {
        return {
            isSystem : true,
            body     : ':15 ;\n',
            handler  : res => {
                if (res.status != 0) {
                    if (!this.opts.mock) {
                        this.error('Failed to get positions', res)
                    }
                    return
                }
               
                const arr = res.body.split('|')
                const floats = Util.floats(arr)
                this.position = [floats[0], floats[1]]
                this.limitsEnabled = [arr[2], arr[3]].map(it => it == 'T')
            }
        }
    }

    async initGpio() {

        this.log('Gpio is', this.opts.gpioEnabled ? 'enabled' : 'disabled')

        this.gpio = new Gpio(this.opts.gpioEnabled, {
            controllerReset    : this.opts.pinControllerReset, 
            controllerStop     : this.opts.pinControllerStop,
            controllerReady   : this.opts.pinControllerReady
        })
        await this.gpio.open()
    }

    log(...args) {
        if (!this.opts.quiet) {
            console.log(new Date, ...args)
        }
    }

    error(...args) {
        console.error(new Date, ...args)
    }
}

class BaseError extends Error {
    constructor(...args) {
        super(...args)
        this.name = this.constructor.name
    }
}

class ConfigError extends BaseError {}

module.exports = App
