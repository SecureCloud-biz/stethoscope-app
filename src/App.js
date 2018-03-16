import React, { Component } from 'react'
import Stethoscope from './lib/Stethoscope'
import Device from './Device'
import Loader from './Loader'
import openSocket from 'socket.io-client'
import moment from 'moment'
import prettyBytes from './lib/prettyBytes'
import getBadge from './lib/getBadge'
import { HOST } from './constants'
import ErrorMessage from './ErrorMessage'
import './App.css'

const socket = openSocket(HOST)

let platform = 'darwin'
let shell, ipcRenderer
// CRA doesn't like importing native node modules, have to use window.require AFAICT
try {
  const os = window.require('os')
  shell = window.require('electron').shell
  platform = os.platform()
  ipcRenderer = window.require('electron').ipcRenderer
} catch (e) {
  // browser polyfill
  ipcRenderer = { on() {}, send() {} }
}

class App extends Component {
  state = {
    device: {},
    policy: {},
    result: {},
    instructions: {},
    loading: false,
    remoteScan: false,
    scannedBy: 'Stethoscope',
    lastScanTime: Date.now(),
    focused: true,
    downloadProgress: null,
  }

  componentWillMount() {
    // perform the initial policy load & scan
    this.loadPractices()
    // this handler tells the main process (in start.js) to resize the window
    // via ipcRenderer.send('download:start') to just contain the progress bar
    // while an update is downloading. 'download:complete' restores the
    // original size when the download is compmlete
    let downloadStartSent = false
    ipcRenderer.on('download:progress', (event, downloadProgress) => {
      // trigger the app resize first time through
      if (!downloadStartSent) {
        ipcRenderer.send('download:start')
        downloadStartSent = true
      }

      if (downloadProgress && downloadProgress.percent >= 99) {
        ipcRenderer.send('download:complete')
        return this.setState({ downloadProgress: null }, () => downloadStartSent = false)
      } else {
        this.setState({ downloadProgress })
      }
    })

    ipcRenderer.on('download:error', (event, error) => {
      ipcRenderer.send('download:complete')
      this.setState({
        downloadProgress: null,
        error,
      }, () => downloadStartSent = false)
    })

    // the focus/blur handlers are used to update the last scanned time
    window.addEventListener('focus', () => this.setState({
      focused: true,
    }), false)

    window.addEventListener('blur', () => this.setState({
      focused: false,
    }), false)

    // the server emits this event when a remote scan begins
    // TODO don't hardcode Meechum and Stethoscope
    socket.on('scan:init', ({ remote }) => {
      ipcRenderer.send('scan:init')
      this.setState({
        loading: true,
        remoteScan: remote,
        scannedBy: remote ? 'Meechum' : 'Stethoscope'
      })
    })

    // setup a socket io listener to refresh the app when a scan is performed
    socket.on('scan:complete', ({ noResults = false, variables, remote, result, policy: appPolicy, showNotification }) => {
      if (noResults) {
        return this.setState({ loading: false, scannedBy: 'Stethoscope' })
      }

      const { data: { policy }} = Object(result)

      let newState = {
        result: policy.validateWithDetails,
        loading: false,
        remoteScan: remote,
        scannedBy: remote ? 'Meechum' : 'Stethoscope'
      }

      // handle old-style requests, policy.validate should not be used anymore
      // TODO remove this logic
      if (!policy.validateWithDetails) {
        const lastScanTime = Date.now()
        newState = {
          result: {
            status: policy.validate
          },
          loading: false,
          lastScanTime,
          policy: appPolicy.policy
        }
      }

      if (newState.result.status !== 'PASS') {
        const len = Object.keys(newState.result).filter(k => newState.result[k] === 'FAIL').length
        const violationCount = len > 1 ? len - 1 : 1
        ipcRenderer.send('scan:violation', getBadge(violationCount), violationCount)
      }

      this.setState(newState, () => {
        if (this.state.result.status !== 'PASS' && showNotification) {
          new Notification('Security recommendation', {
            body: 'You can improve the security settings on this device. Click for more information.'
          })
        }
      })
    })

    // emitted by the server if a new policyServer was sent in a request
    // forces app to download new policy/config/instructions
    socket.on('rescan', () => {
      this.loadPractices()
    })
  }

  handleResponseError = (err) => {
    this.setState({ error: err })
  }

  loadPractices = () => {
    this.setState({ loading: true }, () => {
      Promise.all([
        fetch(`${HOST}/config`).then(d => d.json()).catch(this.handleResponseError),
        fetch(`${HOST}/policy`).then(d => d.json()).catch(this.handleResponseError),
        fetch(`${HOST}/instructions`).then(d => d.json()).catch(this.handleResponseError)
      ]).then(([config, policy, instructions]) => {
        this.setState({ config, policy, instructions }, () => this.scan())
      }).catch(this.handleResponseError)
    })
  }

  loadRemote = (url) => {
    this.loadPractices(url)
  }

  openExternal = event => {
    event.preventDefault()
    if (event.target.getAttribute('href')) {
      shell.openExternal(event.target.getAttribute('href'))
    }
  }

  scan = () => {
    Stethoscope.validate(this.state.policy).then(({ device, result }) => {
      const lastScanTime = Date.now()
      this.setState({
        device,
        result,
        lastScanTime,
        scannedBy: 'Stethoscope',
        loading: false
      })
    }).catch(this.handleResponseError)
  }

  render() {
    const {
      device, policy, result, downloadProgress,
      scannedBy, lastScanTime, error,
      instructions, loading
    } = this.state

    let content = null

    // don't want to render entire app, partition device info, etc. if downloading an update
    if (downloadProgress !== null) {
      content = (
        <div className="App">
          <div id="downloadProgress">
            <p>Downloading update ({prettyBytes(downloadProgress.transferred)} of {prettyBytes(downloadProgress.total)})</p>
            <progress max="100" value={downloadProgress.percent}></progress>
          </div>
        </div>
      )
    }

    if (error) {
      content = (
        <ErrorMessage message={error.message} />
      )
    }

    if (!content) {
      const secInfo = Stethoscope.partitionSecurityInfo(policy, result, device, instructions.practices, platform)
      const decoratedDevice = Object.assign({}, device, secInfo, { lastScanTime })
      const lastScanFriendly = moment(lastScanTime).fromNow()

      content = (
        <div>
          <Device {...decoratedDevice}
            org={instructions.organization}
            scanResult={result}
            policy={policy}
            lastScanTime={lastScanFriendly}
            scannedBy={scannedBy}
          />
          <footer className="toolbar toolbar-footer">
            <div className="buttonRow">
              <button className="btn btn-default" onClick={this.scan}>
                <span className="icon icon-arrows-ccw"></span>rescan
              </button>

              <button
                className="btn btn-primary pull-right"
                href='https://stethoscope.prod.netflix.net/'
                onClick={this.openExternal}
              >
                <span className="icon icon-monitor white"></span>view all devices
              </button>
            </div>
          </footer>
        </div>
      )
    }



    return (
      <div className={`App ${loading ? 'loading' : ''}`}>
        {loading
          ? <Loader remoteScan={this.state.remoteScan} />
          : content
        }
      </div>
    )
  }
}

export default App