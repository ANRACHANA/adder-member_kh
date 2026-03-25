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
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)) }

// ===== Firebase =====
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DB_URL
}
initializeApp(firebaseConfig)
const db = getDatabase()

// ===== Accounts =====
const accounts = []
const clients = {}

// ===== Save Account =====
async function saveAccountToFirebase(account){
  try{
    const snap = await get(ref(db,'accounts'))
    const data = snap.val() || {}
    const exists = Object.values(data).some(a => a.phone === account.phone)
    if(exists) return false
    await update(ref(db,`accounts/${account.id}`),{
      phone:account.phone,
      api_id:account.api_id,
      api_hash:account.api_hash,
      session:account.session,
      status:"active",
      floodWaitUntil:null,
      createdAt:Date.now()
    })
    console.log(`✅ Saved ${account.phone}`)
    return true
  }catch(err){
    console.log("❌ Save error:",err.message)
    return false
  }
}

// ===== Load ENV Accounts =====
let i=1
while(process.env[`TG_ACCOUNT_${i}_PHONE`]){
  const api_id=Number(process.env[`TG_ACCOUNT_${i}_API_ID`])
  const api_hash=process.env[`TG_ACCOUNT_${i}_API_HASH`]
  const session=process.env[`TG_ACCOUNT_${i}_SESSION`]
  const phone=process.env[`TG_ACCOUNT_${i}_PHONE`]
  if(!api_id||!api_hash||!session){i++; continue}

  const account={phone, api_id, api_hash, session, id:`TG_ACCOUNT_${i}`, status:"pending", floodWaitUntil:null}
  accounts.push(account)
  saveAccountToFirebase(account)
  i++
}

// ===== Telegram Client =====
async function getClient(account){
  if(clients[account.id]) return clients[account.id]
  const client=new TelegramClient(new StringSession(account.session), account.api_id, account.api_hash, {connectionRetries:5})
  await client.connect()
  clients[account.id]=client
  return client
}

// ===== Flood Parse =====
function parseFlood(err){
  const msg=err.message||""
  const m1=msg.match(/FLOOD_WAIT_(\d+)/)
  const m2=msg.match(/wait of (\d+) seconds/i)
  if(m1) return Number(m1[1])
  if(m2) return Number(m2[1])
  return null
}

// ===== Refresh Account =====
async function refreshAccountStatus(account){
  if(account.floodWaitUntil && account.floodWaitUntil < Date.now()){
    account.floodWaitUntil=null
    account.status="active"
    await update(ref(db,`accounts/${account.id}`),{status:"active",floodWaitUntil:null})
  }
}

// ===== Check Account =====
async function checkTGAccount(account){
  try{
    await refreshAccountStatus(account)
    const client=await getClient(account)
    await client.getMe()
    account.status="active"
    account.floodWaitUntil=null
    await update(ref(db,`accounts/${account.id}`),{status:"active", phone:account.phone,lastChecked:Date.now(),floodWaitUntil:null})
  }catch(err){
    const wait=parseFlood(err)
    let status="error", floodUntil=null
    if(wait){
      status="floodwait"
      floodUntil=Date.now()+wait*1000
      account.floodWaitUntil=floodUntil
      account.status="floodwait"
    }
    await update(ref(db,`accounts/${account.id}`),{
      status,
      floodWaitUntil:floodUntil,
      error:err.message,
      phone:account.phone,
      lastChecked:Date.now()
    })
  }
}

// ===== Auto Check =====
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
  const now=Date.now()
  return accounts.find(a=>a.status==="active" && (!a.floodWaitUntil || a.floodWaitUntil<now))
}

// ===== Auto Join (Single) =====
async function autoJoin(client, group){
  try{ await client.getEntity(group) }
  catch{
    try{
      const hash = group.includes("t.me/") ? group.split("/").pop() : group
      await client.invoke(new Api.messages.ImportChatInvite({hash}))
    }catch(e){}
  }
}

// ===== Auto Join All Accounts =====
async function autoJoinAllAccounts(group, logCallback){
  for(const acc of accounts){
    try{
      const client = await getClient(acc)
      await autoJoin(client, group)
      logCallback && logCallback(`✅ ${acc.phone} joined ${group}`)
      await sleep(2000)
    }catch(e){
      logCallback && logCallback(`❌ ${acc.phone} failed: ${e.message}`)
    }
  }
}

// ===== /auto-join Route =====
app.post('/auto-join', async(req,res)=>{
  const { group } = req.body
  if(!group) return res.json({status:"failed",reason:"Missing group"})
  let logs = []
  await autoJoinAllAccounts(group, msg => logs.push(msg))
  res.json({status:"done",logs})
})

// ===== Members =====
app.post('/members', async(req,res)=>{
  try{
    const {group, offset=0, limit=100}=req.body
    const acc=getAvailableAccount()
    if(!acc) return res.json({error:"No active account"})
    const client=await getClient(acc)
    await autoJoin(client,group)
    const entity=await client.getEntity(group)
    const participants=await client.getParticipants(entity,{limit,offset})
    const members=participants.filter(p=>!p.bot).map(p=>(({
      user_id:p.id,
      username:p.username,
      access_hash:p.access_hash,
      avatar:`https://t.me/i/userpic/320/${p.id}.jpg`
    })))
    res.json({members, nextOffset:offset+participants.length, hasMore:participants.length===limit})
  }catch(err){
    res.json({error:err.message})
  }
})

// ===== Add Member =====
app.post('/add-member', async(req,res)=>{
  try{
    const {username,user_id,access_hash,targetGroup}=req.body
    const acc=getAvailableAccount()
    if(!acc) return res.json({status:"failed",reason:"All FloodWait",accountUsed:"none"})
    const client=await getClient(acc)
    await autoJoin(client,targetGroup)
    let status="failed", reason="unknown"
    try{
      let userEntity
      if(username) userEntity=await client.getEntity(username)
      else userEntity=new Api.InputUser({userId:user_id, accessHash:BigInt(access_hash)})
      const group=await client.getEntity(targetGroup)
      await client.invoke(new Api.channels.InviteToChannel({channel:group, users:[userEntity]}))
      status="success"
      reason="joined"
      await sleep(30000 + Math.floor(Math.random()*10000))
    }catch(err){
      const wait=parseFlood(err)
      if(wait){
        const until=Date.now()+wait*1000
        acc.floodWaitUntil=until
        acc.status="floodwait"
        await update(ref(db,`accounts/${acc.id}`),{status:"floodwait",floodWaitUntil:until})
        reason=`FloodWait ${wait}s | Ready ${new Date(until).toLocaleString()}`
      }else reason=err.message
    }
    if(status==="success"){
      await push(ref(db,'history'),{
        username,user_id,status,reason,accountUsed:acc.id,timestamp:Date.now()
      })
    }
    res.json({status,reason,accountUsed:acc.id})
  }catch(err){
    res.json({status:"failed",reason:err.message,accountUsed:"unknown"})
  }
})

// ===== Account Status / History =====
app.get('/account-status', async(req,res)=>{
  const snap=await get(ref(db,'accounts'))
  res.json(snap.val()||{})
})
app.get('/history', async(req,res)=>{
  const snap=await get(ref(db,'history'))
  res.json(snap.val()||{})
})

// ===== Frontend =====
const __filename=fileURLToPath(import.meta.url)
const __dirname=path.dirname(__filename)
app.use(express.static(__dirname)) // allow static files
app.get('/', (req,res)=>res.sendFile(path.join(__dirname,'index.html')))

const PORT=process.env.PORT||3000
app.listen(PORT,()=>console.log(`🚀 Server running on ${PORT}`))
