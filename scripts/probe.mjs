// Investigation helper. Public CLI commands do not accept arbitrary JavaScript.
import { readFile } from "node:fs/promises";
import { SpotifyConnection } from "../src/cdp.mjs";
const connection = await SpotifyConnection.connect();
try {
  const expression =
    process.argv[2] === "--file" ? await readFile(process.argv[3], "utf8") : process.argv[2];
  console.log(JSON.stringify(await connection.evaluate(expression), null, 2));
} finally {
  connection.close();
}
