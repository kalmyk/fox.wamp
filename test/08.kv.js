'use strict'

const chai        = require('chai')
const spies       = require('chai-spies')
const expect      = chai.expect
const promised    = require('chai-as-promised')

const sqlite3     = require('sqlite3')
const sqlite      = require('sqlite')

const WAMP     = require('../lib/wamp/protocol')
const WampGate = require('../lib/wamp/gate')
const Router          = require('../lib/router')
const { DbBinder }    = require('../lib/sqlite/dbbinder')
const { SqliteKv }    = require('../lib/sqlite/sqlitekv')
const { MemEngine }   = require('../lib/mono/memengine')
const { ReactEngine } = require('../lib/binder')
const { MemKeyValueStorage } = require('../lib/mono/memkv')
const { BaseRealm }   = require('../lib/realm')
const WampApi         = require('../lib/wamp/api')

chai.use(promised)
chai.use(spies)

const mkMemRealm = async (router) => {
  let realm = new BaseRealm(router, new MemEngine())
  realm.registerKeyValueEngine(['#'], new MemKeyValueStorage())
  return realm
}

const mkDbRealm = async (router) => {
  let db = await sqlite.open({
    filename: ':memory:',
    driver: sqlite3.Database
  })

  let binder = new DbBinder(db)
  await binder.init()
  let realm = new BaseRealm(router, new ReactEngine(binder))

  let kv = new SqliteKv(db)
  await kv.createTables()
  realm.registerKeyValueEngine(['#'], kv)

  return realm
}

const runs = [
  {it: 'mem', mkRealm: mkMemRealm },
  {it: 'db',  mkRealm: mkDbRealm  },
]

describe('08. KV', function () {
  runs.forEach(function (run) {
    describe('event-history:' + run.it, function () {
      let
        router,
        realm,
        api,
        sender,
        gate,
        cli,
        ctx

      beforeEach(async function () {
        router = new Router()
        realm = await run.mkRealm(router)
        router.addRealm('test-realm', realm)       
        api = realm.wampApi()

        sender = {}
        gate = new WampGate(router)
        cli = gate.createSession()
        ctx = gate.createContext(cli, sender)
        realm.joinSession(cli)
      })
    
      afterEach(function () {
        cli.cleanup()
        ctx = null
      })
  
      it('storage-retain-get:' + run.it, async () => {
        var subSpy = chai.spy(() => {})
        await api.subscribe('topic1', subSpy)
        await api.publish('topic1', [], { data: 'retain-the-value' }, { retain: true, exclude_me:false })
        await api.publish('topic1', [], { data: 'the-value-does-not-retain' }, { exclude_me:false })

        let done
        let resultPromise = new Promise((resolve) => done = resolve)
        let counter = 2
        sender.send = chai.spy(
          (msg, callback) => {
            // console.log('MSG =>', counter, msg)
            if (counter === 2) {
              expect(msg[0]).to.equal(WAMP.SUBSCRIBED)
              expect(msg[1]).to.equal(1234)
            } else {
              expect(msg[0]).to.equal(WAMP.EVENT)
              expect(msg[3].topic).to.equal('topic1')
              expect(msg[3].retained).to.equal(true)
              expect(msg[5]).to.deep.equal({ data: 'retain-the-value' })
            }
            --counter
            if (counter <= 0) {
              done()
              done = undefined
            }
          }
        )
        cli.handle(ctx, [WAMP.SUBSCRIBE, 1234, { retained: true }, 'topic1'])
        await resultPromise

        expect(subSpy).to.have.been.called.twice()
      })
  
      it('storage-retain-weak:' + run.it, async () => {
        var spyExists = chai.spy(()=>{})
        var spyNotExists = chai.spy(()=>{})

        await api.publish('topic2', ['arg.1', 'arg.2'], {}, { retain: true, will: null })
        await realm.getKey(['topic2'], spyExists)
        await api.cleanup()
        await realm.getKey(['topic2'], spyNotExists)

        expect(spyExists).to.have.been.called.once()
        expect(spyNotExists).to.not.have.been.called()
      })
  
      it('wamp-key-remove:' + run.it, async () => {
        await api.publish(['topic2'], ['arg.1'], { some: 'value' }, { retain: true })
        var spyExists = chai.spy(()=>{ /* exists */ })
        await realm.getKey(['topic2'], spyExists)

        // no kwargs is sent if kwargs passed as null
        await api.publish('topic2', [], null, { retain: true })

        var spyNotExists = chai.spy(()=>{})
        await realm.getKey(['topic2'], spyNotExists)

        expect(spyExists).to.have.been.called.once()
        expect(spyNotExists).to.not.have.been.called()
      })
  
      it('push-will:' + run.it, async function () {
        let expectedData = [
          { event: 'value' },
          { will: 'value' },
        ]
    
        const event = chai.spy((id, args, kwargs) => {
          expect(kwargs).to.deep.equal(expectedData.shift())
        })
        await api.subscribe('will.test', event)
    
        let cli = new WampApi(realm, router.makeSessionId())
        realm.joinSession(cli)
    
        await cli.publish(
          'will.test',
          [],
          { event: 'value' },
          { trace: true, retain: true, will: { kv: { will: 'value' } } }
        )
    
        expect(event).to.have.been.called.once()
        await cli.cleanup()
        expect(event).to.have.been.called.twice()
      })
    
    })
  })
})
