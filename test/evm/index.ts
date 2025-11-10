import { createWalletClient, http, parseEther } from "viem";
import { contractAddresses, createClients, toEOASigner } from "../integration/utils";
import { localhost } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SsoAccount } from "../integration/account";
import { createDelegation, createDelegationAndInitialize, fundAcc, initializeAccount, log, printAccountInfo, printBalance } from "./utils";
import { ANVIL_PORT, BUNDLER_PORT, DEAD_ADDRESS } from "./constants";
import { addPasskey, generatePasskeys, nativeTransferWithPasskey, verifyPasskeyAdded } from "./passkey";
import { isSessionValidatorInstalled, installSessionValidator, createSession, createBasicSessionSpec, transferWithSession, verifySessionActive } from "./session";
import { randomAddress } from "../integration/utils";

// run this with:
// pnpm exec tsx ./test/evm/deploy-p256.ts && pnpm exec tsx ./test/evm/index.ts
const main = async () => {
    // load deployed contract addresses
    // deploy with: 
    // `forge soldeer install`
    // `pnpm deploy-test`
    const addresses = contractAddresses();
    log(addresses);

    const { client, bundlerClient } = createClients(ANVIL_PORT, BUNDLER_PORT);

    const privateKey = generatePrivateKey() 
    const eoaAccount = privateKeyToAccount(privateKey)

    // 🔵 use a fresh account, fund it
    await fundAcc(eoaAccount.address, client)

    const walletClient = createWalletClient({
        account: eoaAccount,
        chain: localhost,
        transport: http()
    })

    // // 🔵 set delegation to smart account template
    // await createDelegation(client, walletClient, addresses.account)

    // // 🔵 call the initializeAccount function on the delegated EOA
    // await initializeAccount(
    //   addresses,
    //   eoaAccount.address,
    //   walletClient,
    //   client
    // )

    await createDelegationAndInitialize(addresses, client, walletClient, addresses.account)

    // 🔵 verify the account is initialized
    await printAccountInfo(
      client,
      eoaAccount.address,
      addresses.eoaValidator
    )

    // 🔵 send a user operation to the account, transfer 1 ETH to the dead address
    const sso = await SsoAccount.create(client, eoaAccount.address, toEOASigner(privateKey));

    await printBalance(DEAD_ADDRESS, client, "before user operation")

    const hash = await bundlerClient.sendUserOperation({
        account: sso.account,
        calls: [{
            to: DEAD_ADDRESS,
            value: parseEther("1"),
            data: "0x"
        }]
    })
    log("userOperation hash:", hash)
    const receipt = await bundlerClient.waitForUserOperationReceipt({ hash, timeout: 0 });
    log("userOperation receipt.success:", receipt.success)
    if (!receipt.success) {
        log("userOperation receipt:", receipt)
        throw new Error("user operation failed")
    }

    await printBalance(DEAD_ADDRESS, client, "after user operation")

    // 🔵 Passkey workflow
    const passkey = generatePasskeys();
    log("Generated new passkey:", { credentialId: passkey.credentialId, publicKey: passkey.publicKey });
    await addPasskey(eoaAccount.address, privateKey, passkey);
    log("Passkey added");
    await verifyPasskeyAdded(addresses.webauthnValidator, eoaAccount.address, client, passkey); 
    await nativeTransferWithPasskey(eoaAccount.address, passkey);

    // 🔵 Session workflow
    log("\n=== Session Workflow ===");
    
    // Generate a session owner (separate from the account owner)
    const sessionOwnerPrivateKey = generatePrivateKey();
    const sessionOwnerAccount = privateKeyToAccount(sessionOwnerPrivateKey);
    log("Generated session owner:", sessionOwnerAccount.address);
    
    // Check if session validator is installed (it's installed during initializeAccount)
    const isInstalled = await isSessionValidatorInstalled(eoaAccount.address);
    if (!isInstalled) {
        log("Installing session validator...");
        await installSessionValidator(eoaAccount.address, privateKey);
    }
    log("Session validator ready");
    
    // Create a session with transfer permissions
    const recipient = randomAddress();
    log("Session recipient:", recipient);
    
    const sessionSpec = createBasicSessionSpec(sessionOwnerAccount.address, recipient, 1000);
    const sessionHash = await createSession(eoaAccount.address, privateKey, sessionSpec);
    log("Session created with hash:", sessionHash);
    
    // Verify session is active
    await verifySessionActive(eoaAccount.address, sessionHash);
    
    // Transfer using session key
    await printBalance(recipient, client, "before session transfer");
    await transferWithSession(
        eoaAccount.address,
        sessionOwnerPrivateKey,
        sessionSpec,
        recipient,
        50000000000000000n // 0.05 ether
    );
    await printBalance(recipient, client, "after session transfer");

}


main().catch(console.error);
