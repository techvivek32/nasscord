import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorizationHeader,
  baseStringUri,
  createOAuth1Signer,
  hmacSha1,
  normalizeParameters,
  parseAuthorizationHeader,
  parseForm,
  percentEncode,
  signatureBaseString,
  signingKey,
} from "../src/etrade/oauth1.mjs";

// Known-answer vectors, each from a published source:
// [RFC]     RFC 5849 "The OAuth 1.0 Protocol", section 3.4.1 (base string example, its 3.4.1.2 URI
//           examples and the 3.4.1.3.2 normalised parameters).
// [CORE]    OAuth Core 1.0 Revision A, Appendix A.5 (photos.example.net), the classic HMAC-SHA1 vector.
// [TWITTER] X/Twitter developer docs, "Creating a signature" (OAuth 1.0a), statuses/update example.

test("percent-encoding follows RFC 3986 unreserved set [TWITTER examples]", () => {
  assert.equal(percentEncode("Ladies + Gentlemen"), "Ladies%20%2B%20Gentlemen");
  assert.equal(percentEncode("An encoded string!"), "An%20encoded%20string%21");
  assert.equal(percentEncode("Dogs, Cats & Mice"), "Dogs%2C%20Cats%20%26%20Mice");
  assert.equal(percentEncode("☃"), "%E2%98%83");
  assert.equal(percentEncode("-._~"), "-._~");
  assert.equal(percentEncode("!*'()"), "%21%2A%27%28%29");
});

test("base string URI [RFC 3.4.1.2]", () => {
  assert.equal(baseStringUri("http://EXAMPLE.COM:80/r%20v/X?id=123"), "http://example.com/r%20v/X");
  assert.equal(baseStringUri("https://www.example.net:8080/?q=1"), "https://www.example.net:8080/");
});

const RFC_URL = "http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b";
/** @type {Array<[string, string]>} */
const RFC_OAUTH = [
  ["oauth_consumer_key", "9djdj82h48djs9d2"],
  ["oauth_token", "kkk9d7dh3k39sjv7"],
  ["oauth_signature_method", "HMAC-SHA1"],
  ["oauth_timestamp", "137131201"],
  ["oauth_nonce", "7d8f3e4a"],
];

test("parameter normalisation including query and body params [RFC 3.4.1.3.2]", () => {
  const query = parseForm(new URL(RFC_URL).search.slice(1));
  const body = parseForm("c2&a3=2+q");
  assert.deepEqual(body, [["c2", ""], ["a3", "2 q"]]);
  assert.equal(
    normalizeParameters([...query, ...RFC_OAUTH, ...body]),
    "a2=r%20b&a3=2%20q&a3=a&b5=%3D%253D&c%40=&c2=&oauth_consumer_key=9djdj82h48djs9d2&oauth_nonce=7d8f3e4a&oauth_signature_method=HMAC-SHA1&oauth_timestamp=137131201&oauth_token=kkk9d7dh3k39sjv7",
  );
});

test("signature base string [RFC 3.4.1.1]", () => {
  assert.equal(
    signatureBaseString("post", RFC_URL, [...RFC_OAUTH, ...parseForm("c2&a3=2+q")]),
    "POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D%26oauth_consumer_key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk9d7dh3k39sjv7",
  );
});

test("HMAC-SHA1 signature [CORE Appendix A.5]", () => {
  const signer = createOAuth1Signer({ now: () => 1191242096_000, nonce: () => "kllo9940pd9333jh", version: "1.0" });
  const { baseString, signature } = signer.sign({
    method: "GET",
    url: "http://photos.example.net/photos?file=vacation.jpg&size=original",
    consumerKey: "dpf43f3p2l4k3l03",
    consumerSecret: "kd94hf93k423kf44",
    token: "nnch734d00sl2jdk",
    tokenSecret: "pfkkdhi9sl3r4s00",
  });
  assert.equal(
    baseString,
    "GET&http%3A%2F%2Fphotos.example.net%2Fphotos&file%3Dvacation.jpg%26oauth_consumer_key%3Ddpf43f3p2l4k3l03%26oauth_nonce%3Dkllo9940pd9333jh%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1191242096%26oauth_token%3Dnnch734d00sl2jdk%26oauth_version%3D1.0%26size%3Doriginal",
  );
  assert.equal(signingKey("kd94hf93k423kf44", "pfkkdhi9sl3r4s00"), "kd94hf93k423kf44&pfkkdhi9sl3r4s00");
  assert.equal(signature, "tR3+Ty81lMeYAr/Fid0kMTYa/WM=");
});

test("HMAC-SHA1 signature with body params [TWITTER]", () => {
  const signer = createOAuth1Signer({
    now: () => 1318622958_000,
    nonce: () => "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
    version: "1.0",
  });
  const { baseString, signature, params } = signer.sign({
    method: "POST",
    url: "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
    consumerKey: "xvz1evFS4wEEPTGEFPHBog",
    consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
    token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
    tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
    bodyParams: [["status", "Hello Ladies + Gentlemen, a signed OAuth request!"]],
  });
  assert.equal(
    baseString,
    "POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521",
  );
  assert.equal(
    signingKey("kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw", "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE"),
    "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw&LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
  );
  assert.equal(signature, "hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
  assert.equal(params.oauth_signature, "hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
});

test("signing key with no token secret ends in '&' (request token step)", () => {
  assert.equal(signingKey("c s"), "c%20s&");
  assert.equal(hmacSha1("x", "k&"), hmacSha1("x", signingKey("k")));
});

test("Authorization header: realm first, values encoded and quoted, round-trips", () => {
  const h = authorizationHeader({ oauth_consumer_key: "ck", oauth_callback: "oob", oauth_signature: "a+b/c=" }, "");
  assert.equal(h, 'OAuth realm="",oauth_consumer_key="ck",oauth_callback="oob",oauth_signature="a%2Bb%2Fc%3D"');
  assert.deepEqual(parseAuthorizationHeader(h), { realm: "", oauth_consumer_key: "ck", oauth_callback: "oob", oauth_signature: "a+b/c=" });
});

test("the signer adds oauth_callback / oauth_verifier into the signature and uses its clock and nonce", () => {
  const signer = createOAuth1Signer({ now: () => 1_700_000_000_123, nonce: () => "n1" });
  const { params, baseString } = signer.sign({
    method: "GET",
    url: "https://api.etrade.com/oauth/request_token",
    consumerKey: "ck",
    consumerSecret: "cs",
    extra: { oauth_callback: "oob" },
  });
  assert.equal(params.oauth_timestamp, "1700000000");
  assert.equal(params.oauth_nonce, "n1");
  assert.equal(params.oauth_callback, "oob");
  assert.ok(baseString.includes("oauth_callback%3Doob"));
  assert.equal(params.oauth_signature, hmacSha1(baseString, "cs&"));
});
