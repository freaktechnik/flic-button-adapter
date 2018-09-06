'use strict';

const childProcess = require('child_process');
const os = require('os');
const path = require('path');
const flic = require(path.join(__dirname,
                               'fliclib-linux-hci',
                               'clientlib',
                               'nodejs',
                               'fliclibNodeJs.js'));

const {Adapter, Device, Property, Event} = require('gateway-addon');

class ReadonlyProperty extends Property {
    constructor(device, name, description, value) {
        description.writable = false;
        super(device, name, description, value);
    }

    setValue(value) {
        return Promise.reject("Read only property");
    }
}

class FlicButton extends Device {
    constructor(adapter, bdAddr, cc, client, name) {
        super(adapter, `flic-${bdAddr}`);
        if(name) {
            this.name = name;
        }
        else {
            this.name = `Flic button ${bdAddr}`;
        }
        this.bdAddr = bdAddr;
        this.cc = cc;
        this['@type'] = ['PushButton'];

        this.properties.set('battery', new ReadonlyProperty(this, 'battery', {
            type: 'number',
            unit: 'percent',
            label: 'Battery Level',
        }, 100));
        this.properties.set('pushed', new ReadonlyProperty(this, 'pushed', {
            type: 'boolean',
            '@type': 'PushedProperty',
            label: 'Pushed',
        }, false));

        this.addEvent('hold', {});
        this.addEvent('doubleClick', {});
        this.addEvent('singleClick', {});

        this.cc.on("buttonUpOrDown", (clickType) => {
            const property = this.findProperty("pushed");
            property.setCachedValue(clickType === "ButtonDown");
            this.notifyPropertyChanged(property);
        });

        this.cc.on("buttonSingleOrDoubleClickOrHold", (clickType) => {
            switch (clickType) {
                case 'ButtonHold':
                    this.eventNotify(new Event(this, 'hold'));
                    break;
                case 'ButtonDoubleClick':
                    this.eventNotify(new Event(this, 'doubleClick'));
                    break;
                case 'ButtonSingleClick':
                    this.eventNotify(new Event(this, 'singleClick'));
                    break;
            }
        });

        this.batteryStatusListener = new flic.FlicBatteryStatusListener(bdAddr);
        this.batteryStatusListener.on('batteryStatus', (percentage) => {
            const prop = this.findProperty('battery');
            prop.setCachedValue(percentage);
            this.notifyPropertyChanged(prop);
        });

        this.adapter.client.addBatteryStatusListener(this.batteryStatusListener);

        this.adapter.handleDeviceAdded(this);
    }

    unload() {
        this.cc.removeAllListeners("buttonUpOrDown")
        this.adapter.client.removeConnectionChannel(this.cc);
        this.adapter.client.removeBatteryStatusListener(this.batteryStatusListener);
    }
}

class FlicAdapter extends Adapter {
    static get PORT() {
        return 5551;
    }

    static getConfigDirectory() {
        if (process.env.hasOwnProperty('MOZIOT_HOME')) {
            return path.join(process.env.MOZIOT_HOME, 'config');
        }

        return path.join(os.homedir(), '.mozilla-iot', 'config');
    }

    static getBinaryDirectory() {
        switch(process.arch) {
            case 'arm':
            case 'arm64':
                return 'armv6l';
            case 'ia32':
            case 'x32':
                return 'i386';
            case 'x64':
                return 'x86_64';
            default:
                throw new Error("Platform " + process.arch + " not supported");
        }
    }

    static getBinaryPath() {
        if(process.platform !== 'linux') {
            throw new Error("No binary bundled for this platform");
        }
        const directory = this.getBinaryDirectory();
        return path.join(__dirname, 'fliclib-linux-hci', 'bin', directory, 'flicd');
    }

    constructor(addonManager, packageName, config) {
        super(addonManager, 'FlicButtonAdapter', packageName);
        addonManager.addAdapter(this);

        this.connecting = new Set();

        this.startDaemon();

        this.client = new flic.FlicClient("localhost", FlicAdapter.PORT);
        this.client.once("ready", () => {
            this.client.getInfo((info) => {
                for(const bdAddr of info.bdAddrOfVerifiedButtons) {
                    this.addDevice(bdAddr, undefined, false);
                }
            });
        });
    }

    startDaemon() {
        if(process.platform !== 'linux') {
            console.warn("You have to manually start the flic daemon");
            return;
        }

        const binaryPath = FlicAdapter.getBinaryPath();
        const dbPath = path.join(FlicAdapter.getConfigDirectory(), 'flicdb.sqlite');
        this.flicd = childProcess.exec(`sudo ${binaryPath} -f "${dbPath}" -p ${FlicAdapter.PORT} -w`, {
            cwd: __dirname,
            env: process.env
        }, (e) => {
            this.flicd = undefined;
            console.error(e);
            this.unload();
        });
        this.hasDaemon = true;
    }

    async addDevice(bdAddr, name, tryToConnect = true) {
        if(`flic-${bdAddr}` in this.devices || this.connecting.has(bdAddr)) {
            return;
        }
        const cc = new flic.FlicConnectionChannel(bdAddr);
        if(tryToConnect) {
            let timeout;
            this.connecting.add(bdAddr);
            const p = new Promise((resolve, reject) => {
                cc.on("createResponse", function(error, connectionStatus) {
                    if(connectionStatus == "Ready") {
                        // Got verified by someone else between scan result and this event
                        resolve(cc);
                    }
                    else if(error != "NoError") {
                        reject("Too many pending connections");
                    }
                    else {
                        timeout = setTimeout(function() {
                            this.client.removeConnectionChannel(cc);
                        }, 30 * 1000);
                    }
                });
                cc.on("connectionStatusChanged", function(connectionStatus, disconnectReason) {
                    if (connectionStatus == "Ready") {
                        resolve(cc);
                    }
                });
                cc.on("removed", function(removedReason) {
                    if (removedReason == "RemovedByThisClient") {
                        reject("Timed out");
                    }
                    else {
                        reject(removedReason);
                    }
                });
            });
            try {
                this.client.addConnectionChannel(cc);
                await p;
            }
            catch(e) {
                console.error(e);
                this.client.removeConnectionChannel(cc);
            }
            finally {
                if(timeout) {
                    clearTimeout(timeout);
                }
                cc.removeAllListeners('createResponse');
                cc.removeAllListeners('connectionStatusChanged');
                cc.removeAllListeners('removed');
                this.connecting.delete(bdAddr);
            }
        }
        else {
            this.client.addConnectionChannel(cc);
        }
        new FlicButton(this, bdAddr, cc, name);
    }

    removeThing(thing) {
        thing.unload();
        this.client.deleteButton(thing.bdAddr);
        super.removeThing(thing);
    }

    startPairing(timeoutSeconds) {
        if(!this.timeout) {
            this.scanner = new flic.FlicScanner();

            this.timeout = setTimeout(() => this.cancelPairing(), timeoutSeconds * 1000);

            this.scanner.on("advertisementPacket", (bdAddr, name, rssi, isPrivate, alreadyVerified) => {
                if (isPrivate) {
                    console.warn("Your button", name, "is private. Hold down for 7 seconds to make it public.");
                    return;
                }
                this.addDevice(bdAddr, name);
            });
            this.client.addScanner(this.scanner);
        }
    }

    cancelPairing() {
        this.client.removeScanner(this.scanner);
        clearTimeout(this.timeout);
        this.timeout = undefined;
        this.connecting.clear();
    }

    unload() {
        if(this.client) {
            this.client.close();
        }
        if(this.flicd) {
            this.flicd.kill();
        }
        super.unload();
    }
}

module.exports = (addonManager, manifest) => {
    const adapter = new FlicAdapter(addonManager, manifest.name);
};