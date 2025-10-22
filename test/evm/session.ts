import { Address, encodeFunctionData, encodeAbiParameters, parseAbi, PublicClient, Hex, concat } from "viem";
import { SsoAccount } from "../integration/account";
import { contractAddresses, createClients, randomAddress, toEOASigner } from "../integration/utils";
import { ANVIL_PORT, BUNDLER_PORT } from "./constants";
import { log } from "./utils";
import { privateKeyToAccount } from "viem/accounts";

export interface SessionSpec {
    signer: Address;
    expiresAt: number;
    feeLimit: UsageLimit;
    callPolicies: CallSpec[];
    transferPolicies: TransferSpec[];
}

export interface UsageLimit {
    limitType: LimitType;
    limit: bigint;
    period: number;
}

export interface CallSpec {
    target: Address;
    selector: Hex;
    maxValuePerUse: bigint;
    valueLimit: UsageLimit;
    constraints: Constraint[];
}

export interface TransferSpec {
    target: Address;
    maxValuePerUse: bigint;
    valueLimit: UsageLimit;
}

export interface Constraint {
    condition: Condition;
    index: bigint;
    refValue: Hex;
    limit: UsageLimit;
}

export enum LimitType {
    Unlimited = 0,
    Lifetime = 1,
    Allowance = 2,
}

export enum Condition {
    Unconstrained = 0,
    Equal = 1,
    Greater = 2,
    Less = 3,
    GreaterOrEqual = 4,
    LessOrEqual = 5,
    NotEqual = 6,
}

/**
 * Creates a basic session spec for testing
 * @param sessionOwner The address that will sign session transactions
 * @param recipient The address that can receive transfers in this session
 * @param expiresInSeconds How long until the session expires (default 1000 seconds)
 * @returns SessionSpec object
 */
export const createBasicSessionSpec = (
    sessionOwner: Address,
    recipient: Address,
    expiresInSeconds: number = 1000
): SessionSpec => {
    const transferPolicies: TransferSpec[] = [{
        target: recipient,
        maxValuePerUse: BigInt("100000000000000000"), // 0.1 ether
        valueLimit: {
            limitType: LimitType.Unlimited,
            limit: 0n,
            period: 0
        }
    }];

    return {
        signer: sessionOwner,
        expiresAt: Math.floor(Date.now() / 1000) + expiresInSeconds,
        transferPolicies,
        callPolicies: [],
        feeLimit: {
            limitType: LimitType.Lifetime,
            limit: BigInt("150000000000000000"), // 0.15 ether
            period: 0
        }
    };
};

/**
 * Check if the session validator is installed on the account
 * @param accountAddress The account address
 * @returns true if installed, false otherwise
 */
export const isSessionValidatorInstalled = async (accountAddress: Address): Promise<boolean> => {
    const { sessionValidator } = contractAddresses();
    const { client } = createClients(ANVIL_PORT, BUNDLER_PORT);

    const isInstalled = await client.readContract({
        address: accountAddress,
        abi: parseAbi(["function isModuleInstalled(uint256 moduleTypeId, address module, bytes calldata additionalContext) external view returns (bool)"]),
        functionName: "isModuleInstalled",
        args: [1n, sessionValidator, "0x"] // 1 = VALIDATOR type
    });

    return isInstalled as boolean;
};

/**
 * Install the session key validator on the account
 * Note: In most cases, the session validator is already installed during initializeAccount.
 * Use isSessionValidatorInstalled() to check before calling this.
 * @param address The account address
 * @param privateKey The owner's private key
 */
export const installSessionValidator = async (address: Address, privateKey: Hex) => {
    const { sessionValidator } = contractAddresses();
    const { client, bundlerClient } = createClients(ANVIL_PORT, BUNDLER_PORT);
    const sso = await SsoAccount.create(client, address, toEOASigner(privateKey));

    // Install the session validator module
    const hash = await bundlerClient.sendUserOperation({
        account: sso.account,
        calls: [{
            to: address,
            value: 0n,
            data: encodeFunctionData({
                abi: parseAbi(["function installModule(uint256 moduleTypeId, address module, bytes calldata initData) external"]),
                args: [1n, sessionValidator, "0x"], // 1 = VALIDATOR type
            }),
        }],
    });

    log("install session validator user operation hash: ", hash);

    const receipt = await bundlerClient.waitForUserOperationReceipt({ hash, timeout: 0 });

    if (!receipt.success) {
        throw new Error("install session validator failed");
    }
    log("✅ install session validator user operation receipt: ", receipt.receipt);

    return receipt;
};

/**
 * Creates a session on the account
 * @param address The account address
 * @param privateKey The owner's private key
 * @param spec The session specification
 * @returns The session hash
 */
export const createSession = async (
    address: Address,
    privateKey: Hex,
    spec: SessionSpec
): Promise<Hex> => {
    const { sessionValidator } = contractAddresses();
    const { client, bundlerClient } = createClients(ANVIL_PORT, BUNDLER_PORT);
    const sso = await SsoAccount.create(client, address, toEOASigner(privateKey));

    // Encode the session spec for createSession call
    const createSessionData = encodeFunctionData({
        abi: parseAbi([
            "function createSession((address signer, uint48 expiresAt, (uint8 limitType, uint256 limit, uint48 period) feeLimit, (address target, bytes4 selector, uint256 maxValuePerUse, (uint8 limitType, uint256 limit, uint48 period) valueLimit, (uint8 condition, uint64 index, bytes32 refValue, (uint8 limitType, uint256 limit, uint48 period) limit)[] constraints)[] callPolicies, (address target, uint256 maxValuePerUse, (uint8 limitType, uint256 limit, uint48 period) valueLimit)[] transferPolicies) spec) external"
        ]),
        args: [spec],
    });

    // Call createSession on the session validator
    const hash = await bundlerClient.sendUserOperation({
        account: sso.account,
        calls: [{
            to: sessionValidator,
            value: 0n,
            data: createSessionData,
        }],
    });

    log("create session user operation hash: ", hash);

    const receipt = await bundlerClient.waitForUserOperationReceipt({ hash, timeout: 0 });

    if (!receipt.success) {
        throw new Error("create session failed");
    }
    log("✅ create session user operation receipt: ", receipt.receipt);

    // Get session hash from sessionSigner mapping
    const sessionHash = await client.readContract({
        address: sessionValidator,
        abi: parseAbi(["function sessionSigner(address signer) external view returns (bytes32)"]),
        functionName: "sessionSigner",
        args: [spec.signer]
    }) as Hex;

    log("Session hash:", sessionHash);

    return sessionHash;
};

/**
 * Create a session signer function for use with SsoAccount
 * @param sessionOwnerPrivateKey The session owner's private key
 * @param spec The session spec
 * @returns A signer function
 */
export const toSessionSigner = (sessionOwnerPrivateKey: Hex, spec: SessionSpec) => {
    const { sessionValidator } = contractAddresses();
    return async function(userOpHash: Hex): Promise<Hex> {
        // Calculate the number of constraints for periodIds array
        let constraints = 0;
        for (const callPolicy of spec.callPolicies) {
            constraints += callPolicy.constraints.length;
        }
        
        // Create periodIds array (2 + number of constraints)
        const periodIds = new Array(2 + constraints).fill(0n);

        // Sign with session owner's key
        const sessionOwner = privateKeyToAccount(sessionOwnerPrivateKey);
        const signature = await sessionOwner.sign({ hash: userOpHash });

        // Encode signature with session spec and periodIds
        const encodedSig = encodeAbiParameters(
            [
                { type: "bytes" }, // signature
                { 
                    type: "tuple", 
                    components: [
                        { name: "signer", type: "address" },
                        { name: "expiresAt", type: "uint48" },
                        { 
                            name: "feeLimit", 
                            type: "tuple",
                            components: [
                                { name: "limitType", type: "uint8" },
                                { name: "limit", type: "uint256" },
                                { name: "period", type: "uint48" }
                            ]
                        },
                        { 
                            name: "callPolicies", 
                            type: "tuple[]",
                            components: [
                                { name: "target", type: "address" },
                                { name: "selector", type: "bytes4" },
                                { name: "maxValuePerUse", type: "uint256" },
                                { 
                                    name: "valueLimit",
                                    type: "tuple",
                                    components: [
                                        { name: "limitType", type: "uint8" },
                                        { name: "limit", type: "uint256" },
                                        { name: "period", type: "uint48" }
                                    ]
                                },
                                { 
                                    name: "constraints",
                                    type: "tuple[]",
                                    components: [
                                        { name: "condition", type: "uint8" },
                                        { name: "index", type: "uint64" },
                                        { name: "refValue", type: "bytes32" },
                                        { 
                                            name: "limit",
                                            type: "tuple",
                                            components: [
                                                { name: "limitType", type: "uint8" },
                                                { name: "limit", type: "uint256" },
                                                { name: "period", type: "uint48" }
                                            ]
                                        }
                                    ]
                                }
                            ]
                        },
                        { 
                            name: "transferPolicies",
                            type: "tuple[]",
                            components: [
                                { name: "target", type: "address" },
                                { name: "maxValuePerUse", type: "uint256" },
                                { 
                                    name: "valueLimit",
                                    type: "tuple",
                                    components: [
                                        { name: "limitType", type: "uint8" },
                                        { name: "limit", type: "uint256" },
                                        { name: "period", type: "uint48" }
                                    ]
                                }
                            ]
                        }
                    ]
                }, // session spec
                { type: "uint48[]" } // periodIds
            ],
            [signature, spec, periodIds]
        );

        // Prepend validator address to signature
        return concat([sessionValidator, encodedSig]);
    };
};

/**
 * Transfer native currency using a session key
 * 
 * ⚠️  Note: Currently using a hardcoded nonce approach
 * The nonce is calculated as: (sessionSigner << 64) | sequence
 * For first transaction, sequence = 0
 * 
 * @param accountAddress The account address
 * @param sessionOwnerPrivateKey The session owner's private key (who controls the session)
 * @param spec The session spec
 * @param to The recipient address
 * @param amount The amount to transfer
 */
export const transferWithSession = async (
    accountAddress: Address,
    sessionOwnerPrivateKey: Hex,
    spec: SessionSpec,
    to: Address,
    amount: bigint
) => {
    const { client, bundlerClient } = createClients(ANVIL_PORT, BUNDLER_PORT);

    // Create a session signer
    const sessionSigner = toSessionSigner(sessionOwnerPrivateKey, spec);
    
    // Create SsoAccount with session signer
    const sso = await SsoAccount.create(client, accountAddress, sessionSigner);
    
    // HARDCODED NONCE: Calculate manually since viem's getNonce override doesn't work
    // Nonce format: (uint192(sessionSigner) << 64) | sequence
    // For the first transaction with this session, sequence = 0
    const sequence = 0n; // TODO: Query this from EntryPoint if multiple transactions needed
    const nonceKey = BigInt(spec.signer);
    const hardcodedNonce = (nonceKey << 64n) | sequence;
    
    log("Session signer address:", spec.signer);
    log("Session signer as BigInt:", nonceKey.toString());
    log("Session signer as BigInt (hex):", nonceKey.toString(16));
    log("Hardcoded nonce as BigInt:", hardcodedNonce.toString());
    log("Hardcoded nonce as BigInt (hex):", hardcodedNonce.toString(16));
    log("Nonce key (session signer):", nonceKey.toString(16));
    log("Sequence:", sequence.toString());
    
    // Track how many times getNonce is called
    let nonceCallCount = 0;
    
    // Override getNonce to return our hardcoded value
    // Store the original to prevent viem from replacing our override
    const originalGetNonce = sso.account.getNonce;
    Object.defineProperty(sso.account, 'getNonce', {
        value: async () => {
            nonceCallCount++;
            log(`getNonce called (call #${nonceCallCount})`);
            log(`  Returning nonce as BigInt: ${hardcodedNonce.toString()}`);
            log(`  Returning nonce as hex: ${hardcodedNonce.toString(16)}`);
            return hardcodedNonce;
        },
        writable: false, // Prevent viem from overwriting this
        configurable: false
    });
    
    log("Sending user operation with session key...");
    
    // Send the user operation using bundlerClient
    // Session validation is expensive, so we need to provide higher gas limits
    const hash = await bundlerClient.sendUserOperation({
        account: sso.account,
        calls: [{
            to,
            value: amount,
            data: '0x'
        }],
        // Multiply verification gas by 2x to account for session validation overhead
        verificationGasLimit: 200000n,
    });

    log("transfer with session user operation hash: ", hash);

    const receipt = await bundlerClient.waitForUserOperationReceipt({ hash, timeout: 0 });

    if (!receipt.success) {
        throw new Error("transfer with session failed");
    }

    log("✅ transfer with session user operation receipt: ", receipt.receipt);

    // Verify the transfer
    const balance = await client.getBalance({ address: to });
    log(`Recipient balance: ${balance} wei`);

    return receipt;
};

/**
 * Verify that a session is active
 * @param accountAddress The account address
 * @param sessionHash The session hash
 */
export const verifySessionActive = async (accountAddress: Address, sessionHash: Hex) => {
    const { sessionValidator } = contractAddresses();
    const { client } = createClients(ANVIL_PORT, BUNDLER_PORT);

    const status = await client.readContract({
        address: sessionValidator,
        abi: parseAbi(["function sessionStatus(address account, bytes32 sessionHash) external view returns (uint8)"]),
        functionName: "sessionStatus",
        args: [accountAddress, sessionHash]
    });

    log("Session status:", status === 1 ? "Active" : status === 0 ? "NotInitialized" : "Closed");

    if (status !== 1) {
        throw new Error("Session is not active");
    }

    log("✅ Session is active");
    return true;
};

