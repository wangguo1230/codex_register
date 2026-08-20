import assert from "node:assert/strict";
import test from "node:test";
import {createCredentialFileStore} from "./credential-file-store.js";

test("数据库凭证优先于文件回退", () => {
    const store = createCredentialFileStore({readFile: () => '{"from":"file"}'});
    assert.deepEqual(store.readAuth({auth_data: {from: "db"}, auth_file: "auth.json"}), {from: "db"});
    assert.deepEqual(store.readRt({rt_file: "rt.json"}), {from: "file"});
});

test("邮箱 Worker 单行格式保持五段字段契约", () => {
    let output = "";
    const store = createCredentialFileStore({writeFile: (_file, value) => { output = value; }});
    store.writeMailbox("mail.txt", {email: "a@gmail.com", password: "pw", totp_secret: "totp", recovery_email: "r@mail.com", imap_password: "imap"});
    assert.equal(output, "a@gmail.com----pw----totp----r@mail.com----imap\n");
});
