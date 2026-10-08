import 'dotenv/config'
import { createInterface } from 'readline'
import { once } from 'events'
import { addAdmin, hasUsername } from '../lib/users.js'

const isTTY = Boolean(process.stdin.isTTY)

function askLine(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: isTTY })
  process.stdout.write(prompt)
  return new Promise((resolve) => {
    rl.question('', (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

// Saisie de mot de passe sans écho (TTY uniquement)
function readSecret(prompt) {
  if (!isTTY) return askLine(prompt)
  process.stdout.write(prompt)
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    stdin.setRawMode(true)
    stdin.resume()
    let buf = ''
    const onData = (chunk) => {
      for (const code of chunk) {
        if (code === 3) {
          finish()
          reject(new Error('Annulé.'))
          return
        }
        if (code === 13 || code === 10) {
          finish()
          resolve(buf)
          return
        }
        if (code === 127 || code === 8) {
          if (buf.length) {
            buf = buf.slice(0, -1)
            process.stdout.write('\b \b')
          }
          continue
        }
        buf += String.fromCharCode(code)
        process.stdout.write('*')
      }
    }
    const finish = () => {
      stdin.removeListener('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stdout.write('\n')
    }
    stdin.on('data', onData)
  })
}

async function readArgsFromPipe() {
  const rl = createInterface({ input: process.stdin })
  const lines = []
  rl.on('line', (l) => lines.push(l))
  await once(rl, 'close')
  return { username: (lines[0] || '').trim(), password: lines[1] || '', confirm: lines[2] || '' }
}

async function main() {
  console.log('── Lumo : ajouter un administrateur ──')
  console.log('Les administrateurs ne peuvent être créés que via cette commande.\n')

  let username, password, confirm
  if (!isTTY) {
    const args = await readArgsFromPipe()
    username = args.username
    password = args.password
    confirm = args.confirm
  } else {
    username = (await askLine('Pseudo admin : ')).trim()
    try {
      password = await readSecret('Mot de passe (min. 10 caractères) : ')
    } catch (err) {
      console.error(err.message)
      process.exit(1)
    }
    confirm = await readSecret('Confirmez le mot de passe : ')
  }

  if (!username) {
    console.error('Pseudo invalide.')
    process.exit(1)
  }
  if (hasUsername(username)) {
    console.error('Ce pseudo est déjà pris.')
    process.exit(1)
  }
  if (password.length < 10) {
    console.error('Le mot de passe doit faire au moins 10 caractères.')
    process.exit(1)
  }
  if (password !== confirm) {
    console.error('Les mots de passe ne correspondent pas.')
    process.exit(1)
  }

  try {
    const admin = await addAdmin(username, password)
    console.log(`✅ Admin « ${admin.username} » créé (${new Date(admin.createdAt).toLocaleString('fr-FR')}).`)
    console.log('Vous pouvez vous connecter sur Lumo avec ce compte.')
    console.log('⚠️ Redémarrez le serveur Lumo pour charger ce compte — tant que le serveur tourne,')
    console.log('   il travaille sur une copie en mémoire et une écriture concurrente pourrait l\'écraser.')
  } catch (err) {
    console.error(`❌ ${err.message}`)
    process.exit(1)
  }
}

main()