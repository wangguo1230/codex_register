import {setMailClaimPaused} from "../server/db.ts";
import {clearMailboxJobStop} from "../src/mail/mailbox-job-stop.ts";
const pause = process.argv[2] !== "off";
clearMailboxJobStop();
await setMailClaimPaused(pause);
console.log(pause ? "paused" : "unpaused", "stop_cleared");
