import {
  encodeAbiParameters,
  Hex,
  pad,
  concat,
  toHex,
  type Address,
  type PublicClient,
} from "viem";

import {
  toSmartAccount,
  getUserOperationHash,
  entryPoint08Abi,
  entryPoint08Address,
  type SmartAccount
} from "viem/account-abstraction";

import { hashTypedData, wrapTypedDataSignature } from "viem/experimental/erc7739";

const callAbi = [{
    components: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
    ],
    name: 'Call',
    type: 'tuple[]',
}];

type Signer = (hash: Hex) => Promise<Hex>;

export class SsoAccount {
    public account: SmartAccount;
    public signer: Signer;

    private constructor() {}

    public static async create(client: PublicClient, address: Address, signer: Signer) {
        const sso = new SsoAccount();
        sso.signer = signer;

        const account = await toSmartAccount({
            client,
            entryPoint: {
                address: entryPoint08Address,
                version: '0.8',
                abi: entryPoint08Abi
            },
            async encodeCalls(calls) {
                const selector = '0xe9ae5c53'; // execute(bytes32,bytes)
                
                if (calls.length === 1) {
                    // Single call mode (0x00)
                    // Format: target (20 bytes) | value (32 bytes) | data (remaining bytes)
                    const modeCode = pad('0x00', { dir: 'right' });
                    const call = calls[0];
                    const executionData = concat([
                        call.to,  // 20 bytes address (NOT padded)
                        pad(toHex(call.value ?? 0n), { size: 32 }),  // pad value to 32 bytes
                        call.data ?? '0x'  // raw data bytes
                    ]);
                    return concat([
                        selector,
                        encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes' }], [modeCode, executionData])
                    ]);
                } else {
                    // Batch call mode (0x01)
                    const modeCode = pad('0x01', { dir: 'right' });
                    const executionData = encodeAbiParameters(
                        callAbi,
                        [calls.map(call => ({ to: call.to, value: call.value ?? 0n, data: call.data ?? '0x' }))]
                    );
                    return concat([
                        selector,
                        encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes' }], [modeCode, executionData])
                    ]);
                }
            },
            async getAddress() {
                return address;
            },
            async getNonce() {
                return await client.readContract({
                    abi: entryPoint08Abi,
                    address: entryPoint08Address,
                    functionName: 'getNonce',
                    args: [address, 0n]
                });
            },
            async getStubSignature() {
                // bad signature, but correct format
                return await sso.signer(pad("0x", { size: 32 }));
            },
            async signUserOperation(userOperation) {
                const userOpHash = getUserOperationHash({
                    userOperation: { ...userOperation, sender: address },
                    entryPointAddress: entryPoint08Address,
                    entryPointVersion: '0.8',
                    chainId: 1337
                });
                return await sso.signer(userOpHash);
            },
            async decodeCalls(data) {
                // Not used tests
                return [];
            },
            async getFactoryArgs() {
                // Not used tests
                return {};
            },
            async signMessage(message) {
                // Not used in tests
                return "0x";
            },
            async signTypedData(typedData) {
                const verifierDomain = {
                    chainId: 1337,
                    name: "zksync-sso-1271",
                    version: "1.0.0",
                    verifyingContract: address,
                    salt: pad('0x', { size: 32 })
                };
                const erc7739Data: any = {
                    ...typedData,
                    verifierDomain
                }
                const hash = hashTypedData(erc7739Data);
                const signature = await sso.signer(hash);
                return wrapTypedDataSignature({
                    ...erc7739Data,
                    signature
                });
            },
        })

        sso.account = account;
        return sso;
    }
}
