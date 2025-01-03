import { AutoRouter, cors, error } from "npm:itty-router@5.0.18";
import { verifyJwt } from "npm:@atproto/xrpc-server@0.7.4";
import { IdResolver } from "npm:@atproto/identity@0.4.3";
import * as earthstar from "jsr:@earthstar/earthstar@11.0.0-beta.7";
import { isDid, extractDidMethod } from "npm:@atproto/did@0.1.3";
import { encodeIdentityTag } from "https://jsr.io/@earthstar/earthstar/11.0.0-beta.7/src/identifiers/identity.ts";
import { encodeBase32 } from "https://jsr.io/@earthstar/earthstar/11.0.0-beta.7/src/encoding/base32.ts";

type Keypair = { publicKey: Uint8Array; secretKey: Uint8Array };

// TODO: add a DID cache using Deno KV
const idResolver = new IdResolver();
async function getSigningKey(
  did: string,
  forceRefresh: boolean
): Promise<string> {
  const atprotoData = await idResolver.did.resolveAtprotoData(
    did,
    forceRefresh
  );
  return atprotoData.signingKey;
}

const db = await Deno.openKv();
function generateKeypair(): Promise<Keypair> {
  return new earthstar.RuntimeDriverUniversal().ed25519.generateKeypair();
}
async function getKeypair(did: string): Promise<Keypair> {
  const entry = await db.get<Keypair>(["keys", did]);
  if (entry.value) {
    return entry.value;
  }
  const newKeypair = await generateKeypair();
  await db.set(["keys", did], newKeypair);
  return newKeypair;
}
async function getPublicKey(did: string): Promise<string> {
  const keypair = await getKeypair(did);
  return encodeIdentityTag({
    shortname: "auth",
    underlying: keypair.publicKey,
  });
}
async function getEncodedKeypair(
  did: string
): Promise<{ publicKey: string; secretKey: string }> {
  const keypair = await getKeypair(did);
  return {
    publicKey: encodeIdentityTag({
      shortname: "auth",
      underlying: keypair.publicKey,
    }),
    secretKey: encodeBase32(keypair.secretKey),
  };
}

const { preflight, corsify } = cors();
const router = AutoRouter({
  before: [preflight],
  finally: [corsify],
});

const serviceDid = Deno.env.get("DID");

if (!serviceDid)
  throw new Error(
    "Must set DID environment variable to the DID of this deployed service."
  );

// Return the service DID
router.get("/.well-known/did.json", ({ url }) => ({
  "@context": ["https://www.w3.org/ns/did/v1"],
  id: serviceDid,
  service: [
    {
      id: "#pigeon_keyserver",
      type: "PigeonKeyserver",
      serviceEndpoint: (() => {
        const u = new URL(url);
        u.pathname = "/";
        return u.href;
      })(),
    },
  ],
}));

type JwtPayload = Awaited<ReturnType<typeof verifyJwt>>;
type AuthCtx = {
  jwtPayload: JwtPayload;
  did: string;
};

type Ctx = Request & AuthCtx;

// Get a user's public key
router.get("/xrpc/public.key.pigeon.muni.town", async ({ query }) => {
  let { did } = query;
  if (typeof did !== "string" || !did)
    return error(400, "DID query parameter required");
  did = decodeURIComponent(did);
  if (!isDid(did)) return error(400, "Invalid DID");
  const didMethod = extractDidMethod(did);
  if (didMethod !== "web" && didMethod !== "plc")
    return error(
      400,
      `Invalid DID method: '${did}'. Expected either 'web' or 'plc'`
    );

  return {
    publicKey: await getPublicKey(did),
  };
});

//
// AUTH WALL
//
// ALL REQUESTS PAST THIS POINT REQUIRE AUTH
//

router.all("*", async (ctx) => {
  const url = new URL(ctx.url);
  if (!url.pathname.startsWith("/xrpc/")) return error(404);
  const lxm = url.pathname.split("/xrpc/")[1];

  const authorization = ctx.headers.get("authorization");
  if (!authorization) return error(403, "Authorization token required.");
  if (!authorization.startsWith("Bearer "))
    return error(403, "Bearer token required");
  const jwt = authorization.split("Bearer ")[1];
  let jwtPayload: JwtPayload;
  try {
    jwtPayload = await verifyJwt(jwt, serviceDid, lxm, getSigningKey);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("Error validating JWT:", e);
    return error(403, "Could not validate authorization JWT.");
  }

  ctx.jwtPayload = jwtPayload;
  ctx.did = jwtPayload.iss;

  return undefined;
});

// Get the user's personal keypair
router.get("/xrpc/key.pigeon.muni.town", ({ did }: Ctx) =>
  getEncodedKeypair(did)
);

Deno.serve(router.fetch);
