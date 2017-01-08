const moment = require('moment')

const ticker = require('../ticker')
const settingsLoader = require('../settings-loader')

const db = require('../db')

const CONSIDERED_UP_SECS = 30

function machinesLastPing () {
  const sql = `select name, min(extract(epoch from (now() - machine_events.created))) as age
  from machine_events, devices
  where machine_events.device_id = devices.device_id
  group by name`

  return db.any(sql)
  .then(r => {
    const downRows = r.filter(row => row.age > CONSIDERED_UP_SECS)
    if (downRows.length === 0) return 'All machines are up'

    if (downRows.length === 1) {
      const row = downRows[0]
      const age = moment.duration(row.age, 'seconds')
      return `${row.name} down for ${age.humanize()}`
    }

    return 'Multiple machines down'
  })
}

function status () {
  const sql = `select extract(epoch from (now() - created)) as age
  from server_events
  where event_type=$1
  order by created desc
  limit 1`

  return Promise.all([db.oneOrNone(sql, ['ping']), machinesLastPing()])
  .then(([statusRow, machineStatus]) => {
    if (!statusRow) return {up: false, lastPing: null, machineStatus}

    const age = moment.duration(statusRow.age, 'seconds')
    const up = statusRow.age < CONSIDERED_UP_SECS
    const lastPing = age.humanize()

    return settingsLoader.loadLatest()
    .then(settings => {
      return ticker.getRates(settings, 'USD', 'BTC')
      .then(ratesRec => {
        const rates = [{
          crypto: 'BTC',
          bid: parseFloat(ratesRec.rates.bid),
          ask: parseFloat(ratesRec.rates.ask)
        }]
        return {up, lastPing, rates, machineStatus}
      })
    })
  })
}

module.exports = {status}