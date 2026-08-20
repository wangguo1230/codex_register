import assert from "node:assert/strict";
import test from "node:test";
import {selectMailJump} from "./mailcom-send-service.js";

test("邮箱跳板关闭时不使用旧版回退跳板", () => {
    assert.equal(
        selectMailJump(false, "socks5://leased-jump", "socks5://127.0.0.1:10812"),
        "",
    );
});

test("邮箱跳板开启时优先使用租约跳板", () => {
    assert.equal(
        selectMailJump(true, "socks5://leased-jump", "socks5://127.0.0.1:10812"),
        "socks5://leased-jump",
    );
    assert.equal(
        selectMailJump(true, "", "socks5://127.0.0.1:10812"),
        "socks5://127.0.0.1:10812",
    );
});
