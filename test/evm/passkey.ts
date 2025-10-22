import { Address, encodeFunctionData, Hex, parseAbi, PublicClient, toHex } from "viem";
import { SsoAccount } from "../integration/account";
import { contractAddresses, createClients, randomAddress, toEOASigner, toPasskeySigner } from "../integration/utils";
import { ANVIL_PORT, BUNDLER_PORT } from "./constants";
import crypto from "crypto";
import { log } from "./utils";

interface TestPassKey {
    credentialId: Hex;
    publicKey: {
        x: Hex;
        y: Hex;
    };
    keyPair: crypto.KeyPairKeyObjectResult;
    jwk: crypto.JsonWebKey;
}

export const generatePasskeys = () => {
    const credentialId = toHex(crypto.randomBytes(16));
    const keyPair = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = keyPair.publicKey.export({ format: "jwk" });
    const publicKey = {
        x: toHex(Buffer.from(jwk.x!, "base64url")),
        y: toHex(Buffer.from(jwk.y!, "base64url")),
    };

    return {
        credentialId,
        publicKey,
        keyPair,
        jwk,
    } as TestPassKey
}

export const addPasskey = async (address: Address, privateKey: Hex, passkey: TestPassKey) => {
    const { webauthnValidator } = contractAddresses();
    const { client, bundlerClient } = createClients(ANVIL_PORT, BUNDLER_PORT);
    const sso = await SsoAccount.create(client, address, toEOASigner(privateKey));

    // add validation key via the passkey validator contract
    const hash = await bundlerClient.sendUserOperation({
        account: sso.account,
        calls: [{
            to: webauthnValidator,
            value: 0n,
            data: encodeFunctionData({
                abi: parseAbi(["function addValidationKey(bytes memory credentialId, bytes32[2] memory newKey, string memory originDomain) public"]),
                args: [passkey.credentialId, [passkey.publicKey.x, passkey.publicKey.y], "https://example.com"],
            }),
        }],
    });

    log("add passkey user operation hash: ", hash)

    const receipt = await bundlerClient.waitForUserOperationReceipt({ hash, timeout: 0 });

    if (!receipt.success) {
        throw new Error("add passkey failed")
    }
    log("✅ add passkey user operation receipt: ", receipt.receipt)

    return receipt;
}

export const nativeTransferWithPasskey = async (address: Address, passkey: TestPassKey) => {
    const { client, bundlerClient } = createClients(ANVIL_PORT, BUNDLER_PORT);
    const sso = await SsoAccount.create(client, address, toPasskeySigner(passkey.keyPair.privateKey, passkey.credentialId));

    // transfer to a random address using passkey signer
    const target = randomAddress();
    const hash = await bundlerClient.sendUserOperation({
        account: sso.account,
        calls: [{
            to: target,
            value: 1n
        }],
    });

    const receipt = await bundlerClient.waitForUserOperationReceipt({ hash, timeout: 0 });
    if (!receipt.success) {
        throw new Error("user operation with passkey signer failed")
    }

    log("user operation with passkey signer successful, receipt: ", receipt)

    const balance = await client.getBalance({ address: target });
    if (balance !== 1n) {
        throw new Error("target should receive 1 wei")
    }

    return receipt;
}

export const verifyPasskeyAdded = async (webauthnValidator: Address, eoaAddress: Address, client: PublicClient, passkey: TestPassKey) => {

    // Verify webauthn validator is installed on the account
    const isWebauthnInstalled = await client.readContract({
        address: eoaAddress,
        abi: [{
            inputs: [{ name: "moduleTypeId", type: "uint256" }, { name: "module", type: "address" }, { name: "additionalContext", type: "bytes" }],
            name: "isModuleInstalled",
            outputs: [{ name: "", type: "bool" }],
            stateMutability: "view",
            type: "function"
        }],
        functionName: "isModuleInstalled",
        args: [1n, webauthnValidator, "0x"] // 1 = VALIDATOR type
    });
    log("Is WebAuthn validator installed:", isWebauthnInstalled);

    // Verify the key was stored correctly
    const storedAddress = await client.readContract({
        address: webauthnValidator,
        abi: [{
            inputs: [{ name: "originDomain", type: "string" }, { name: "credentialId", type: "bytes" }],
            name: "registeredAddress",
            outputs: [{ name: "", type: "address" }],
            stateMutability: "view",
            type: "function"
        }],
        functionName: "registeredAddress",
        args: ["https://example.com", passkey.credentialId]
    });
    log("Stored address for passkey:", storedAddress, "Expected:", eoaAddress);
    if (storedAddress !== eoaAddress) {
        throw new Error("Stored address for passkey does not match expected address")
    } else {
        log("✅ Stored address for passkey matches expected address")
    }
}