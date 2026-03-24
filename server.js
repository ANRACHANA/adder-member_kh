import 'dotenv/config'
import express from 'express'
import { initializeApp } from 'firebase/app'
import { getDatabase, ref, set, push, get, update } from 'firebase/database'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'

const app = express()
app.use(express.json())

// ===== Firebase =====
const firebaseConfig = {
  apiKey: process.env.FIREBASE_APIKEY,
  authDomain: process.env.FIREBASE_AUTHDOMAIN,
  databaseURL: process.env.FIREBASE_DBURL,
  projectId: process.env.FIREBASE_PROJECTID,
  storageBucket: process.env.FIREBASE_STORAGE,
  messagingSenderId: process.env.FIREBASE_MSGID,
  appId: process.env.FIREBASE_APPID
}

const firebaseApp = initializeApp(firebaseConfig)
const db = getDatabase(firebaseApp)

// ===== In-memory accounts =====
let accounts = {} // phone -> {client, status, floodWaitUntil, phone}

// ===== Helper =====
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)) }

// ===== Load accounts from Firebase =====
async function loadAccounts(){
  const snap = await get(ref(db,'accounts'))
  if(snap.exists()){
    const data = snap.val()
    for(const phone in data){
      if(!accounts[phone]){
        accounts[phone] = {status:'inactive', floodWaitUntil:0, phone, client:null, ...data[phone]}
      }
    }
  }
}
await loadAccounts()

// ===== API: Account status =====
app.get('/account-status', async (req,res)=>{
  const obj={}
  for(const phone in accounts){
    obj[phone] = {status:accounts[phone].status, floodWaitUntil:accounts[phone].floodWaitUntil, phone}
  }
  res.json(obj)
})

// ===== API: Fetch members =====
app.post('/members', async (req,res)=>{
  const {group, offset=0, limit=100} = req.body
  try{
    const phone = Object.keys(accounts)[0]
    const acc = accounts[phone]
    if(!acc.client){
      const snap = await get(ref(db,`accounts/${phone}/session`))
      acc.client = new TelegramClient(new StringSession(snap.val()), acc.api_id, acc.api_hash, {connectionRetries:5})
      await acc.client.start({phoneNumber:async()=>phone})
    }
    const full = await acc.client.getParticipants(group,{offset, limit})
    const members = full.map(u=>({
      username:u.username,
      user_id:u.id,
      access_hash:u.accessHash?.toString(),
      avatar:u.photo?.small?.url || ''
    }))
    res.json({members, nextOffset: offset+members.length, hasMore:members.length===limit})
  }catch(e){
    console.log(e)
    res.json({error:e.message})
  }
})

// ===== API: Add member =====
app.post('/add-member', async (req,res)=>{
  const {username,user_id,access_hash,targetGroup} = req.body
  try{
    // Pick next available account
    const now = Date.now()
    let acc = Object.values(accounts).find(a=>a.status==='active' && (!a.floodWaitUntil || a.floodWaitUntil<now))
    if(!acc) return res.json({status:'failed', reason:'No available accounts', accountUsed:null})

    const client = acc.client
    try{
      if(username){
        await client.invoke({
          _: 'messages.AddChatUser',
          chat_id: targetGroup,
          user_id: { _: 'inputUser', user_id, access_hash },
          fwd_limit: 0
        })
      }else{
        await client.invoke({
          _: 'messages.AddChatUser',
          chat_id: targetGroup,
          user_id: { _: 'inputUser', user_id, access_hash },
          fwd_limit: 0
        })
      }

      // log to Firebase
      const logRef = push(ref(db,'history'))
      await set(logRef,{
        username,
        user_id,
        status:'success',
        accountUsed:acc.phone,
        timestamp:Date.now()
      })

      res.json({status:'success', accountUsed:acc.phone})
    }catch(e){
      let reason=e.message
      if(e.message.includes('FLOOD_WAIT')){
        const sec = parseInt(e.message.match(/\d+/)[0])*1000
        acc.floodWaitUntil = Date.now()+sec
        reason = 'FloodWait '+sec/1000+'s'
      }
      const logRef = push(ref(db,'history'))
      await set(logRef,{
        username,
        user_id,
        status:'failed',
        reason,
        accountUsed:acc.phone,
        timestamp:Date.now()
      })
      res.json({status:'failed', reason, accountUsed:acc.phone})
    }
  }catch(e){
    res.json({status:'failed', reason:e.message, accountUsed:null})
  }
})

// ===== API: History =====
app.get('/history', async (req,res)=>{
  const snap = await get(ref(db,'history'))
  res.json(snap.val() || {})
})

// ===== Start server =====
app.listen(3000,()=>console.log('Server running on port 3000'))
