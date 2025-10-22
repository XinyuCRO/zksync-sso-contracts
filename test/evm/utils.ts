
import {
    createWalletClient,
    http,
    formatEther,
    PublicClient,
    parseEther,
    Address,
    WalletClient,
    encodeFunctionData,
    encodeAbiParameters,
    type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { localhost } from "viem/chains";
import { ANVIL_PRIVATE_KEY } from "./constants";

export const log = (message?: any, ...optionalParams: any[]) => {
    console.log(message, ...optionalParams)
}

export const printBalance = async (
    address: Address,
    client: PublicClient,
    heading: string
) => {
    const balance = await client.getBalance({ address })
    log(`${heading} ${address} balance: ${formatEther(balance)} ETH`)
}

export const fundAcc = async (
    address: Address,
    client: PublicClient
) => {

    // anvil first PK
    const account = privateKeyToAccount(ANVIL_PRIVATE_KEY)
    const wallet = createWalletClient({
        account,
        chain: localhost,
        transport: http(),
    })
    const balanceBefore = await client.getBalance({
        address: address
    })
    log("balanceBefore", formatEther(balanceBefore), "ETH");

    const tx = await wallet.sendTransaction({
        value: parseEther("10"),
        to: address
    })

    const receipt = await client.waitForTransactionReceipt({
        hash: tx
    })

    if (receipt.status != "success") {
        throw "fundAcc failed"
    }

    const balanceAfter = await client.getBalance({
        address: address
    })

    log("balanceAfter", formatEther(balanceAfter), "ETH");
}

export const createDelegation = async (
    client: PublicClient,
    walletClient: WalletClient,
    impl: Address
) => {
    if (!walletClient.account) {
        throw new Error("Wallet client has no account");
    }

    const eoaCodeBefore = await client.getCode({
        address: walletClient.account.address
    })
    log("eoaCode before: ", eoaCodeBefore)

    const authorization = await walletClient.signAuthorization({
        account: walletClient.account,
        contractAddress: impl,
        executor: "self",
    })

    const hash = await walletClient.sendTransaction({
        account: walletClient.account,
        chain: localhost,
        authorizationList: [authorization],
        data: "0x",
        to: walletClient.account.address,
    });
    log(`Delegated at tx ${hash}`);

    await client.waitForTransactionReceipt({
        hash
    })

    const eoaCodeAfter = await client.getCode({
        address: walletClient.account.address
    })
    log("eoaCode after: ", eoaCodeAfter)

}

export const initializeAccount = async (
    addresses: any,
    eoaAddress: Address,
    walletClient: WalletClient,
    client: PublicClient
) => {
    if (!walletClient.account) {
        throw new Error("Wallet client has no account");
    }
    const modules = [
        addresses.eoaValidator,
        addresses.sessionValidator,
        addresses.webauthnValidator,
        addresses.guardiansExecutor
    ];

    // Prepare init data for each module
    // For validators, typically encode the owner address
    const initData: Hex[] = [
        encodeAbiParameters(
            [{ type: 'address[]' }],
            [[eoaAddress]] // EOA owner
        ),
        "0x", // sessionValidator init data
        "0x", // webauthnValidator init data
        "0x"  // guardiansExecutor init data
    ];

    // Encode the initializeAccount function call
    const callData = encodeFunctionData({
        abi: [{
            name: 'initializeAccount',
            type: 'function',
            stateMutability: 'payable',
            inputs: [
                { name: 'modules', type: 'address[]' },
                { name: 'data', type: 'bytes[]' }
            ],
            outputs: []
        }],
        functionName: 'initializeAccount',
        args: [modules, initData]
    });

    // Call initializeAccount on the delegated EOA
    const initHash = await walletClient.sendTransaction({
        to: eoaAddress, // Send to the EOA itself (which is now delegated to MSA)
        data: callData,
        chain: localhost,
        account: walletClient.account
    });

    log(`InitializeAccount tx: ${initHash}`);

    const initReceipt = await client.waitForTransactionReceipt({
        hash: initHash
    });

    log(`InitializeAccount status: ${initReceipt.status}`);
}

export const printAccountInfo = async (
    client: PublicClient,
    eoaAddress: Address,
    eoaValidatorAddress: Address
) => {
    const isValidatorSupported = await client.readContract({
        address: eoaAddress,
        abi: [{
            name: 'supportsModule',
            type: 'function',
            inputs: [{ name: 'modulTypeId', type: 'uint256' }],
            outputs: [{ name: 'isSupported', type: 'bool' }]
        }],
        functionName: 'supportsModule',
        args: [1]
    })
    log("isValidatorSupported", isValidatorSupported)

    const isEoaModuleInstalled = await client.readContract({
        address: eoaAddress,
        abi: [{
            name: 'isModuleInstalled',
            type: 'function',
            inputs: [{ name: 'moduleTypeId', type: 'uint256' }, { name: 'module', type: 'address' }, { name: 'additionalContext', type: 'bytes' }],
            outputs: [{ name: 'isInstalled', type: 'bool' }]
        }],
        functionName: 'isModuleInstalled',
        args: [1, eoaValidatorAddress, "0x"]
    })
    log("isEoaModuleInstalled", isEoaModuleInstalled)
}