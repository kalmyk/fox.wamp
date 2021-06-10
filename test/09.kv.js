'use strict'

const chai        = require('chai')
const spies       = require('chai-spies')
const expect      = chai.expect
const assert      = chai.assert
const promised    = require('chai-as-promised')

const FoxGate      = require('../lib/hyper/gate')
const FoxRouter    = require('../lib/fox_router')

chai.use(promised)
chai.use(spies)

describe('09. hyper-kv', function () {
  let
    router,
    gate,
    sessionSender,
    realm,
    ctx,
    session,
    api

  beforeEach(function () {
    router = new FoxRouter()
    realm = router.createRealm('test-realm')
    gate = new FoxGate(router)
    session = gate.createSession()
    sessionSender = {}
    ctx = gate.createContext(session, sessionSender)
    realm.joinSession(session)
    api = realm.wampApi()
  })

  afterEach(function () {
    if (session) {
      gate.removeSession(session)
      session = null
    }
  })

  it('push-watch-for-push', async function () {
    let curPromise
    let n = 0
    sessionSender.send = (msg) => {
      n++
      if (n === 1) {
        expect(msg).to.deep.equal({ id: 'init-kv', rsp: 'OK', data: undefined })
      } else if (n === 2) {
        expect(msg).to.deep.equal({ id: 'watch-for-value', rsp: 'OK', data: undefined })
      }
      curPromise()
      curPromise = undefined
    }

    const api = realm.foxApi()

    let m = 0
    const onEvent = chai.spy((event, opt) => {
      m++
      if (m === 1) {
        expect(event).to.deep.equal({ kv: { event: 'value' } })
      } else if (m === 2) {
        expect(event).to.equal(null)
      } else if (m === 3) {
        expect(event).to.deep.equal({ kv: { event: 'watch-for-empty' } })
      }
    })

    api.subscribe(['watch', 'test'], onEvent, { retained:true })
    await new Promise((resolve) => {
      curPromise = resolve
      session.handle(ctx, {
        ft: 'PUSH',
        data: { kv: { event: 'value' } },
        uri: ['watch', 'test'],
        opt: {
          retain: true,
          trace: true
        },
        ack: true,
        id: 'init-kv'
      })
    })
    expect(onEvent).to.have.been.called.once()

    session.handle(ctx, {
      ft: 'PUSH',
      data: { kv: { event: 'watch-for-empty' } },
      uri: ['watch', 'test'],
      opt: {
        trace: true,
        retain: true,
        when: null,
        watch: true
      },
      ack: true,
      id: 'watch-for-value'
    })
    expect(onEvent).to.have.been.called.once()

    await new Promise((resolve) => {
      curPromise = resolve
      api.publish(['watch', 'test'], null, { trace: true, retain: true })  
    })
    expect(onEvent).to.have.been.called.exactly(3)
  })

  it('push-watch-for-will', function () {
    let defer = []
    sessionSender.send = chai.spy((msg) => {})

    const api = realm.wampApi()

    let m = 0
    const event = chai.spy((id, args, kwargs) => {
      m++
      if (m === 1) {
        expect(args).to.deep.equal([])
        expect(kwargs).to.deep.equal({ event: 'value-1' })        
      } else if (m === 2) {
        expect(args).to.deep.equal([])
        expect(kwargs).to.deep.equal(undefined)
      } else if (m === 3) {
        expect(args).to.deep.equal([])
        expect(kwargs).to.deep.equal({ event: 'value-2' })
      } else {
        expect(true).to.equal('no more events')
      }
    })
    api.subscribe('watch.test', event, { retained: true })

    session.handle(ctx, {
      ft: 'PUSH',
      data: { kv: { event: 'value-1' } },
      uri: ['watch', 'test'],
      opt: {
        retain: true,
        trace: true,
        when: null,
        will: null
      },
      ack: true,
      id: 'init-kv'
    })

    defer.push(assert.isRejected(
      api.publish(
        'watch.test',
        [],
        { event: 'value-no-watch' },
        {
          retain: true,
          trace: true,
          when: null,
          will: null,
          acknowledge: true
        }
      )
    ))

    defer.push(assert.becomes(
      api.publish(
        'watch.test',
        [],
        { event: 'value-2' },
        {
          retain: true,
          trace: true,
          when: null,
          will: null,
          watch: true,
          acknowledge: true,
          exclude_me: false
        }
      ).then(() => {
        expect(session, 'after disconnect').to.equal(null)
        return 'LOCK-DONE'
      }),
      'LOCK-DONE'
    ))

    session.cleanup()
    session = null

    return Promise.all(defer).then(() => {
      expect(event).to.have.been.called.exactly(3)
    })
  })
})
