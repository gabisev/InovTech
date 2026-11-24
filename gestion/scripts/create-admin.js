const { randomBytes, scrypt: scryptCallback } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const readline = require("node:readline");
const { Pool } = require("pg");

const scrypt = promisify(scryptCallback);

function askLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function askSecret(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
      reject(new Error("Lancez cette commande depuis un terminal interactif."));
      return;
    }

    process.stdout.write(question);
    let value = "";
    const onData = (chunk) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          reject(new Error("Saisie annulée."));
          return;
        }
        if (char === "\r" || char === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
        } else if (char >= " ") {
          value += char;
        }
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL n’est pas défini.");
  const name = await askLine("Nom de l’administrateur : ");
  const email = (await askLine("Adresse e-mail : ")).toLowerCase();
  const password = await askSecret("Mot de passe (12 caractères minimum) : ");
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12) {
    throw new Error("Nom, adresse e-mail ou mot de passe invalide.");
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : false,
  });
  try {
    await pool.query(fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
    const salt = randomBytes(16);
    const hash = await scrypt(password, salt, 64);
    await pool.query(
      "INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, 'admin')",
      [name, email, `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`],
    );
    console.log("Compte administrateur créé. Gardez son mot de passe en lieu sûr.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
