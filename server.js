import 'dotenv/config'
import express from 'express'
import { initializeApp } from 'firebase/app'
import { getDatabase, ref, update, get, push } from 'firebase/database'
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import path from 'path'
import { fileURLToPath } from 'url'

const app = express()
app.use(express.json())
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ===== Firebase =====
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DB_URL
}
initializeApp(firebaseConfig)
const db = getDatabase()

// ===== Telegram Accounts =====
const accounts = []
const clients = {}

// ===== Helpers =====
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)) }

function parseFlood(err){
  const msg = err.message || ''
  const m1 = msg.match(/FLOOD_WAIT_(\d+)/)
  const m2 = msg.match(/wait of (\d+) seconds/i)
  if(m1) return Number(m1[1])
  if(m2) return Number(m2[1])
  return null
}

// ===== Firebase Account Save =====
async function saveAccountToFirebase(account){
  try{
    const snap = await get(ref(db,'accounts'))
    const data = snap.val() || {}
    const exists = Object.values(data).some(a => a.phone === account.phone)
    if(exists) return false
    await update(ref(db,`accounts/${account.id}`),{
      phone: account.phone,
      api_id: account.api_id,
      api_hash: account.api_hash,
      session: account.session,
      status: "active",
      floodWaitUntil: null,
      createdAt: Date.now()
    })
    console.log(`✅ Saved ${account.phone}`)
    return true
  }catch(err){
    console.log("❌ Save error:", err.message)
    return false
  }
}

// ===== Load ENV Accounts =====
let i=1
while(process.env[`TG_ACCOUNT_${i}_PHONE`]){
  const api_id = Number(process.env[`TG_ACCOUNT_${i}_API_ID`])
  const api_hash = process.env[`TG_ACCOUNT_${i}_API_HASH`]
  const session = process.env[`TG_ACCOUNT_${i}_SESSION`]
  const phone = process.env[`TG_ACCOUNT_${i}_PHONE`]
  if(!api_id||!api_hash||!session){ i++; continue }
  const account = { phone, api_id, api_hash, session, id:`TG_ACCOUNT_${i}`, status:"pending", floodWaitUntil:null }
  accounts.push(account)
  saveAccountToFirebase(account)
  i++
}

// ===== Telegram Client =====
async function getClient(account){
  if(clients[account.id]) return clients[account.id]
  const client = new TelegramClient(
    new StringSession(account.session),
    account.api_id,
    account.api_hash,
    { connectionRetries:5 }
  )
  await client.connect()
  clients[account.id] = client
  return client
}

// ===== Refresh Account Status =====
async function refreshAccountStatus(account){
  if(account.floodWaitUntil && account.floodWaitUntil < Date.now()){
    account.floodWaitUntil = null
    account.status = "active"
    await update(ref(db,`accounts/${account.id}`), { status:"active", floodWaitUntil:null })
  }
}

// ===== Check Account =====
async function checkTGAccount(account){
  try{
    await refreshAccountStatus(account)
    const client = await getClient(account)
    await client.getMe()
    account.status="active"
    account.floodWaitUntil=null
    await update(ref(db,`accounts/${account.id}`),{
      status:"active",
      lastChecked: Date.now(),
      floodWaitUntil:null
    })
  }catch(err){
    const wait = parseFlood(err)
    let status="error", floodUntil=null
    if(wait){
      status="floodwait"
      floodUntil = Date.now()+wait*1000
      account.floodWaitUntil=floodUntil
      account.status="floodwait"
    }
    await update(ref(db,`accounts/${account.id}`),{
      status,
      floodWaitUntil:floodUntil,
      error:err.message,
      lastChecked:Date.now()
    })
  }
}

// ===== Auto Check Accounts =====
async function autoCheck(){
  for(const acc of accounts){
    await refreshAccountStatus(acc)
    await checkTGAccount(acc)
    await sleep(2000)
  }
}
setInterval(autoCheck,60000)
autoCheck()

// ===== Get Available Account =====
function getAvailableAccount(){
  const now = Date.now()
  return accounts.find(a=>a.status==="active" && (!a.floodWaitUntil || a.floodWaitUntil<now))
}

// ===== Auto Join Group =====
async function autoJoin(client, group){
  try{ await client.getEntity(group) }
  catch{
    try{
      const hash = group.includes("t.me/") ? group.split("/").pop() : group
      await client.invoke(new Api.messages.ImportChatInvite({hash}))
    }catch{}
  }
}

// ===== Members Fetch =====
app.post('/members', async (req,res)=>{
  try{
    const {group, offset=0, limit=100} = req.body
    const acc = getAvailableAccount()
    if(!acc) return res.json({error:"No active account"})
    const client = await getClient(acc)
    await autoJoin(client,group)
    const entity = await client.getEntity(group)
    const participants = await client.getParticipants(entity,{limit,offset})
    const members = participants.filter(p=>!p.bot).map(p=>({
      user_id:p.id,
      username:p.username,
      access_hash:p.access_hash,
      avatar:`https://t.me/i/userpic/320/${p.id}.jpg`
    }))
    res.json({members, nextOffset:offset+participants.length, hasMore:participants.length===limit})
  }catch(err){
    res.json({error:err.message})
  }
})

// ===== Add Member =====
app.post('/add-member', async (req,res)=>{
  try{
    const {username,user_id,access_hash,targetGroup} = req.body
    const acc = getAvailableAccount()
    if(!acc) return res.json({status:"failed",reason:"All FloodWait",accountUsed:"none"})
    const client = await getClient(acc)
    await autoJoin(client,targetGroup)
    let status="failed", reason="unknown"
    try{
      let userEntity
      if(username) userEntity = await client.getEntity(username)
      else userEntity = new Api.InputUser({userId:user_id, accessHash:BigInt(access_hash)})
      const group = await client.getEntity(targetGroup)
      await client.invoke(new Api.channels.InviteToChannel({channel:group, users:[userEntity]}))
      status="success"; reason="joined"
    }catch(err){
      const wait = parseFlood(err)
      if(wait){
        const until = Date.now()+wait*1000
        acc.floodWaitUntil = until
        acc.status = "floodwait"
        await update(ref(db,`accounts/${acc.id}`),{status:"floodwait",floodWaitUntil:until})
        const ready = new Date(until).toLocaleString()
        reason = `FloodWait ${wait}s | Ready ${ready}`
      }else reason=err.message
    }
    await push(ref(db,'history'),{
      username,user_id,status,reason,
      accountUsed:acc.id,
      timestamp:Date.now()
    })
    res.json({status,reason,accountUsed:acc.id})
  }catch(err){
    res.json({status:"failed",reason:err.message,accountUsed:"unknown"})
  }
})

// ===== Check History =====
app.post('/check-history', async (req,res)=>{
  try{
    const {members} = req.body
    if(!Array.isArray(members)||members.length===0) return res.json({checked:[]})
    const snap = await get(ref(db,'history'))
    const data = snap.val() || {}
    const checked = members.map(m=>{
      const exists = Object.values(data).some(e=> (m.username && e.username===m.username)||(m.user_id && e.user_id===m.user_id))
      return {...m, exists}
    })
    res.json({checked})
  }catch(err){ res.json({checked:[], error:err.message}) }
})

// ===== Add / Upload Accounts =====
app.post('/add-account',async(req,res)=>{
  try{
    const {phone, api_id, api_hash, session} = req.body
    if(!phone||!api_id||!api_hash||!session) return res.json({status:"failed",reason:"Missing fields"})
    const id=`TG_${Date.now()}`
    const account={phone,api_id:Number(api_id),api_hash,session,id,status:"active",floodWaitUntil:null}
    const saved=await saveAccountToFirebase(account)
    if(!saved) return res.json({status:"skipped",reason:"Duplicate"})
    accounts.push(account)
    res.json({status:"success",account})
  }catch(err){ res.json({status:"failed",reason:err.message}) }
})

app.post('/upload-accounts',async(req,res)=>{
  try{
    const {accountsList} = req.body
    let success=0, skipped=0
    for(const acc of accountsList){
      const account={phone:acc.phone,api_id:Number(acc.api_id),api_hash:acc.api_hash,session:acc.session,id:`TG_${Date.now()}_${Math.random()}`,status:"active",floodWaitUntil:null}
      const saved=await saveAccountToFirebase(account)
      if(saved){ accounts.push(account); success++ } else skipped++
    }
    res.json({status:"done",success,skipped})
  }catch(err){ res.json({status:"failed",reason:err.message}) }
})

// ===== Account Status =====
app.get('/account-status', async(req,res)=>{
  const snap = await get(ref(db,'accounts'))
  res.json(snap.val()||{})
})

// ===== Full History =====
app.get('/history', async(req,res)=>{
  const snap = await get(ref(db,'history'))
  res.json(snap.val()||{})
})

// ===== Frontend =====
app.get('/', (req,res)=>res.sendFile(path.join(__dirname,'index.html')))

const PORT = process.env.PORT||3000
app.listen(PORT, ()=>console.log(`🚀 Server running on ${PORT}`))
