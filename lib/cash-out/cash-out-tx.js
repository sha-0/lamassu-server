const _ = require('lodash/fp')
const pgp = require('pg-promise')()
const pEachSeries = require('p-each-series')

const db = require('../db')
const billMath = require('../bill-math')
const T = require('../time')
const logger = require('../logger')
const plugins = require('../plugins')

const helper = require('./cash-out-helper')
const cashOutAtomic = require('./cash-out-atomic')
const cashOutActions = require('./cash-out-actions')
const cashOutLow = require('./cash-out-low')

module.exports = {
  post,
  monitorLiveIncoming,
  monitorStaleIncoming,
  monitorUnnotified,
  cancel
}

const STALE_INCOMING_TX_AGE = T.day
const STALE_LIVE_INCOMING_TX_AGE = 10 * T.minutes
const MAX_NOTIFY_AGE = T.day
const MIN_NOTIFY_AGE = 5 * T.minutes
const INSUFFICIENT_FUNDS_CODE = 570

const toObj = helper.toObj

function httpError (msg, code) {
  const err = new Error(msg)
  err.name = 'HTTPError'
  err.code = code || 500

  return err
}

function selfPost (tx, pi) {
  return post(tx, pi, false)
}

function post (tx, pi, fromClient = true) {
  return db.tx(cashOutAtomic.atomic(tx, pi, fromClient))
    .then(txVector => {
      const [, newTx] = txVector
      return postProcess(txVector, pi)
        .then(changes => cashOutLow.update(db, newTx, changes))
    })
}

function postProcess (txVector, pi) {
  const [oldTx, newTx] = txVector

  if ((newTx.dispense && !oldTx.dispense) || (newTx.redeem && !oldTx.redeem)) {
    return pi.buildAvailableCassettes(newTx.id)
      .then(cassettes => {
        const bills = billMath.makeChange(cassettes.cassettes, newTx.fiat)

        if (!bills) throw httpError('Out of bills', INSUFFICIENT_FUNDS_CODE)
        return bills
      })
      .then(bills => {
        const provisioned1 = bills[0].provisioned
        const provisioned2 = bills[1].provisioned
        const denomination1 = bills[0].denomination
        const denomination2 = bills[1].denomination

        const rec = {
          provisioned_1: provisioned1,
          provisioned_2: provisioned2,
          denomination_1: denomination1,
          denomination_2: denomination2
        }

        return cashOutActions.logAction(db, 'provisionNotes', rec, newTx)
          .then(_.constant({bills}))
      })
      .catch(err => {
        return cashOutActions.logError(db, 'provisionNotesError', err, newTx)
          .then(() => { throw err })
      })
  }

  return Promise.resolve({})
}

function fetchOpenTxs (statuses, age) {
  const sql = `select *
  from cash_out_txs
  where ((extract(epoch from (now() - created))) * 1000)<$1
  and status in ($2^)`

  const statusClause = _.map(pgp.as.text, statuses).join(',')

  return db.any(sql, [age, statusClause])
    .then(rows => rows.map(toObj))
}

function processTxStatus (tx, settings) {
  const pi = plugins(settings, tx.deviceId)

  return pi.getStatus(tx)
    .then(res => _.assign(tx, {status: res.status}))
    .then(_tx => selfPost(_tx, pi))
}

function monitorLiveIncoming (settings) {
  const statuses = ['notSeen', 'published', 'insufficientFunds']

  return fetchOpenTxs(statuses, STALE_LIVE_INCOMING_TX_AGE)
    .then(txs => pEachSeries(txs, tx => processTxStatus(tx, settings)))
    .catch(logger.error)
}

function monitorStaleIncoming (settings) {
  const statuses = ['notSeen', 'published', 'authorized', 'instant', 'rejected', 'insufficientFunds']

  return fetchOpenTxs(statuses, STALE_INCOMING_TX_AGE)
    .then(txs => pEachSeries(txs, tx => processTxStatus(tx, settings)))
    .catch(logger.error)
}

function monitorUnnotified (settings) {
  const sql = `select *
  from cash_out_txs
  where ((extract(epoch from (now() - created))) * 1000)<$1
  and notified=$2 and dispense=$3
  and phone is not null
  and status in ('instant', 'confirmed')
  and (redeem=$4 or ((extract(epoch from (now() - created))) * 1000)>$5)`

  const notify = tx => plugins(settings, tx.deviceId).notifyConfirmation(tx)
  return db.any(sql, [MAX_NOTIFY_AGE, false, false, true, MIN_NOTIFY_AGE])
    .then(rows => _.map(toObj, rows))
    .then(txs => Promise.all(txs.map(notify)))
    .catch(logger.error)
}

function cancel (txId) {
  const updateRec = {
    error: 'Operator cancel',
    error_code: 'operatorCancel',
    dispense: true
  }

  return Promise.resolve()
    .then(() => {
      return pgp.helpers.update(updateRec, null, 'cash_out_txs') +
      pgp.as.format(' where id=$1', [txId])
    })
    .then(sql => db.result(sql, false))
    .then(res => {
      if (res.rowCount !== 1) throw new Error('No such tx-id')
    })
    .then(() => cashOutActions.logActionById(db, 'operatorCompleted', {}, txId))
}
