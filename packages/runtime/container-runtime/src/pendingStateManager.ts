/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { IDisposable } from "@fluidframework/core-interfaces";
import { assert, Lazy } from "@fluidframework/core-utils/internal";
import {
	ITelemetryLoggerExt,
	DataProcessingError,
	LoggingError,
	extractSafePropertiesFromMessage,
} from "@fluidframework/telemetry-utils/internal";
import Deque from "double-ended-queue";
import { v4 as uuid } from "uuid";

import {
	type InboundContainerRuntimeMessage,
	type InboundSequencedContainerRuntimeMessage,
	type LocalContainerRuntimeMessage,
} from "./messageTypes.js";
import { asBatchMetadata, asEmptyBatchLocalOpMetadata } from "./metadata.js";
import { BatchId, BatchMessage, generateBatchId, InboundBatch } from "./opLifecycle/index.js";

/**
 * This represents a message that has been submitted and is added to the pending queue when `submit` is called on the
 * ContainerRuntime. This message has either not been ack'd by the server or has not been submitted to the server yet.
 *
 * @remarks This is the current serialization format for pending local state when a Container is serialized.
 */
export interface IPendingMessage {
	type: "message";
	referenceSequenceNumber: number;
	content: string;
	localOpMetadata: unknown;
	opMetadata: Record<string, unknown> | undefined;
	sequenceNumber?: number;
	/** Info about the batch this pending message belongs to, for validation and for computing the batchId on reconnect */
	batchInfo: {
		/** The Batch's original clientId, from when it was first flushed to be submitted */
		clientId: string;
		/**
		 * The Batch's original clientSequenceNumber, from when it was first flushed to be submitted
		 *	@remarks A negative value means it was not yet submitted when queued here (e.g. disconnected right before flush fired)
		 */
		batchStartCsn: number;
		/** length of the batch (how many runtime messages here) */
		length: number;
	};
}

type Patch<T, U> = U & Omit<T, keyof U>;

/** First version of the type (pre-dates batchInfo) */
type IPendingMessageV0 = Patch<IPendingMessage, { batchInfo?: undefined }>;

/**
 * Union of all supported schemas for when applying stashed ops
 *
 * @remarks When the format changes, this type should update to reflect all possible schemas.
 */
type IPendingMessageFromStash = IPendingMessageV0 | IPendingMessage;

export interface IPendingLocalState {
	/**
	 * list of pending states, including ops and batch information
	 */
	pendingStates: IPendingMessage[];
}

/** Info needed to replay/resubmit a pending message */
export type PendingMessageResubmitData = Pick<
	IPendingMessage,
	"content" | "localOpMetadata" | "opMetadata"
>;

export interface IRuntimeStateHandler {
	connected(): boolean;
	clientId(): string | undefined;
	applyStashedOp(content: string): Promise<unknown>;
	reSubmitBatch(batch: PendingMessageResubmitData[], batchId: BatchId): void;
	isActiveConnection: () => boolean;
	isAttached: () => boolean;
}

function isEmptyBatchPendingMessage(message: IPendingMessageFromStash): boolean {
	const content = JSON.parse(message.content);
	return content.type === "groupedBatch" && content.contents?.length === 0;
}

function buildPendingMessageContent(message: InboundSequencedContainerRuntimeMessage): string {
	// IMPORTANT: Order matters here, this must match the order of the properties used
	// when submitting the message.
	const { type, contents, compatDetails }: InboundContainerRuntimeMessage = message;
	// Any properties that are not defined, won't be emitted by stringify.
	return JSON.stringify({ type, contents, compatDetails });
}

function typesOfKeys<T extends object>(obj: T): Record<keyof T, string> {
	return Object.keys(obj).reduce((acc, key) => {
		acc[key] = typeof obj[key];
		return acc;
	}, {}) as Record<keyof T, string>;
}

function scrubAndStringify(
	message: InboundContainerRuntimeMessage | LocalContainerRuntimeMessage,
): string {
	// Scrub the whole object in case there are unexpected keys
	const scrubbed: Record<string, unknown> = typesOfKeys(message);

	// For these known/expected keys, we can either drill in (for contents)
	// or just use the value as-is (since it's not personal info)
	scrubbed.contents = message.contents && typesOfKeys(message.contents);
	scrubbed.compatDetails = message.compatDetails;
	scrubbed.type = message.type;

	return JSON.stringify(scrubbed);
}

function withoutLocalOpMetadata(message: IPendingMessage): IPendingMessage {
	return {
		...message,
		localOpMetadata: undefined,
	};
}

/**
 * Get the effective batch ID for the input argument.
 * Supports either an IPendingMessage or an InboundBatch.
 * If the batch ID is explicitly present, return it.
 * Otherwise, generate a new batch ID using the client ID and batch start CSN.
 */
function getEffectiveBatchId(
	pendingMessageOrInboundBatch: IPendingMessage | InboundBatch,
): string {
	if ("localOpMetadata" in pendingMessageOrInboundBatch) {
		const pendingMessage: IPendingMessage = pendingMessageOrInboundBatch;
		return (
			asBatchMetadata(pendingMessage.opMetadata)?.batchId ??
			generateBatchId(
				pendingMessage.batchInfo.clientId,
				pendingMessage.batchInfo.batchStartCsn,
			)
		);
	}

	const inboundBatch: InboundBatch = pendingMessageOrInboundBatch;
	return (
		inboundBatch.batchId ?? generateBatchId(inboundBatch.clientId, inboundBatch.batchStartCsn)
	);
}

/**
 * PendingStateManager is responsible for maintaining the messages that have not been sent or have not yet been
 * acknowledged by the server. It also maintains the batch information for both automatically and manually flushed
 * batches along with the messages.
 * When the Container reconnects, it replays the pending states, which includes manual flushing
 * of messages and triggering resubmission of unacked ops.
 *
 * It verifies that all the ops are acked, are received in the right order and batch information is correct.
 */
export class PendingStateManager implements IDisposable {
	/** Messages that will need to be resubmitted if not ack'd before the next reconnection */
	private readonly pendingMessages = new Deque<IPendingMessage>();
	/** Messages stashed from a previous container, now being rehydrated. Need to be resubmitted. */
	private readonly initialMessages = new Deque<IPendingMessageFromStash>();

	/**
	 * Sequenced local ops that are saved when stashing since pending ops may depend on them
	 */
	private savedOps: IPendingMessage[] = [];

	/** Used to stand in for batchStartCsn for messages that weren't submitted (so no CSN) */
	private negativeCounter: number = -1;

	private readonly disposeOnce = new Lazy<void>(() => {
		this.initialMessages.clear();
		this.pendingMessages.clear();
	});

	/** Used to ensure we don't replay ops on the same connection twice */
	private clientIdFromLastReplay: string | undefined;

	/**
	 * The pending messages count. Includes `pendingMessages` and `initialMessages` to keep in sync with
	 * 'hasPendingMessages'.
	 */
	public get pendingMessagesCount(): number {
		return this.pendingMessages.length + this.initialMessages.length;
	}

	/**
	 * The minimumPendingMessageSequenceNumber is the minimum of the first pending message and the first initial message.
	 *
	 * We need this so that we can properly keep local data and maintain the correct sequence window.
	 */
	public get minimumPendingMessageSequenceNumber(): number | undefined {
		return this.pendingMessages.peekFront()?.referenceSequenceNumber;
	}

	/**
	 * Called to check if there are any pending messages in the pending message queue.
	 * @returns A boolean indicating whether there are messages or not.
	 */
	public hasPendingMessages(): boolean {
		return this.pendingMessagesCount !== 0;
	}

	public getLocalState(snapshotSequenceNumber?: number): IPendingLocalState {
		assert(
			this.initialMessages.isEmpty(),
			0x2e9 /* "Must call getLocalState() after applying initial states" */,
		);
		// Using snapshot sequence number to filter ops older than our latest snapshot.
		// Such ops should not be declared in pending/stashed state. Snapshot seq num will not
		// be available when the container is not attached. Therefore, no filtering is needed.
		const newSavedOps = [...this.savedOps].filter((message) => {
			assert(
				message.sequenceNumber !== undefined,
				0x97c /* saved op should already have a sequence number */,
			);
			return message.sequenceNumber > (snapshotSequenceNumber ?? 0);
		});
		this.pendingMessages.toArray().forEach((message) => {
			if (
				snapshotSequenceNumber !== undefined &&
				message.referenceSequenceNumber < snapshotSequenceNumber
			) {
				throw new LoggingError("trying to stash ops older than our latest snapshot");
			}
		});
		return {
			pendingStates: [
				...newSavedOps,
				...this.pendingMessages.toArray().map(withoutLocalOpMetadata),
			],
		};
	}

	constructor(
		private readonly stateHandler: IRuntimeStateHandler,
		stashedLocalState: IPendingLocalState | undefined,
		private readonly logger: ITelemetryLoggerExt,
	) {
		if (stashedLocalState?.pendingStates) {
			this.initialMessages.push(...stashedLocalState.pendingStates);
		}
	}

	public get disposed() {
		return this.disposeOnce.evaluated;
	}
	public readonly dispose = () => this.disposeOnce.value;

	/**
	 * The given batch has been flushed, and needs to be tracked locally until the corresponding
	 * acks are processed, to ensure it is successfully sent.
	 * @param batch - The batch that was flushed
	 * @param clientSequenceNumber - The CSN of the first message in the batch,
	 * or undefined if the batch was not yet sent (e.g. by the time we flushed we lost the connection)
	 */
	public onFlushBatch(batch: BatchMessage[], clientSequenceNumber: number | undefined) {
		// If we're connected this is the client of the current connection,
		// otherwise it's the clientId that just disconnected
		// It's only undefined if we've NEVER connected. This is a tight corner case and we can
		// simply make up a unique ID in this case.
		const clientId = this.stateHandler.clientId() ?? uuid();

		// If the batch was not yet sent, we need to assign a unique batchStartCsn
		// Use a negative number to distinguish these from real CSNs
		const batchStartCsn = clientSequenceNumber ?? this.negativeCounter--;

		for (const message of batch) {
			const {
				contents: content = "",
				referenceSequenceNumber,
				localOpMetadata,
				metadata: opMetadata,
			} = message;
			const pendingMessage: IPendingMessage = {
				type: "message",
				referenceSequenceNumber,
				content,
				localOpMetadata,
				opMetadata,
				// Note: We only will read this off the first message, but put it on all for simplicity
				batchInfo: { clientId, batchStartCsn, length: batch.length },
			};
			this.pendingMessages.push(pendingMessage);
		}
	}

	/**
	 * Applies stashed ops at their reference sequence number so they are ready to be ACKed or resubmitted
	 * @param seqNum - Sequence number at which to apply ops. Will apply all ops if seqNum is undefined.
	 */
	public async applyStashedOpsAt(seqNum?: number) {
		// apply stashed ops at sequence number
		while (!this.initialMessages.isEmpty()) {
			if (seqNum !== undefined) {
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				const peekMessage = this.initialMessages.peekFront()!;
				if (peekMessage.referenceSequenceNumber > seqNum) {
					break; // nothing left to do at this sequence number
				}
				if (peekMessage.referenceSequenceNumber < seqNum) {
					throw new Error("loaded from snapshot too recent to apply stashed ops");
				}
			}
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const nextMessage = this.initialMessages.shift()!;
			// Nothing to apply if the message is an empty batch.
			// We still need to track it for resubmission.
			try {
				if (isEmptyBatchPendingMessage(nextMessage)) {
					nextMessage.localOpMetadata = { emptyBatch: true }; // equivalent to applyStashedOp for empty batch
					patchbatchInfo(nextMessage); // Back compat
					this.pendingMessages.push(nextMessage);
					continue;
				}
				// applyStashedOp will cause the DDS to behave as if it has sent the op but not actually send it
				const localOpMetadata = await this.stateHandler.applyStashedOp(nextMessage.content);
				if (!this.stateHandler.isAttached()) {
					if (localOpMetadata !== undefined) {
						throw new Error("Local Op Metadata must be undefined when not attached");
					}
				} else {
					nextMessage.localOpMetadata = localOpMetadata;
					// then we push onto pendingMessages which will cause PendingStateManager to resubmit when we connect
					patchbatchInfo(nextMessage); // Back compat
					this.pendingMessages.push(nextMessage);
				}
			} catch (error) {
				throw DataProcessingError.wrapIfUnrecognized(error, "applyStashedOp", nextMessage);
			}
		}
	}

	/**
	 * Compares the batch ID of the incoming batch with the pending batch ID for this client.
	 * They should not match, as that would indicate a forked container.
	 * @param remoteBatch - An incoming batch *NOT* submitted by this client
	 * @returns whether the batch IDs match
	 */
	private remoteBatchMatchesPendingBatch(remoteBatch: InboundBatch): boolean {
		// We may have no pending changes - if so, no match, no problem.
		const pendingMessage = this.pendingMessages.peekFront();
		if (pendingMessage === undefined) {
			return false;
		}

		// We must compare the effective batch IDs, since one of these ops
		// may have been the original, not resubmitted, so wouldn't have its batch ID stamped yet.
		const pendingBatchId = getEffectiveBatchId(pendingMessage);
		const inboundBatchId = getEffectiveBatchId(remoteBatch);

		return pendingBatchId === inboundBatchId;
	}

	/**
	 * Processes an inbound batch of messages - May be local or remote.
	 *
	 * @param batch - The inbound batch of messages to process. Could be local or remote.
	 * @param local - true if we submitted this batch and expect corresponding pending messages
	 * @returns The inbound batch's messages with localOpMetadata "zipped" in.
	 *
	 * @throws a DataProcessingError in either of these cases:
	 * - The pending message content doesn't match the incoming message content for any message in the batch
	 * - The batch IDs *do match* but it's not a local batch (indicates Container forking).
	 */
	public processInboundBatch(
		batch: InboundBatch,
		local: boolean,
	): {
		message: InboundSequencedContainerRuntimeMessage;
		localOpMetadata?: unknown;
	}[] {
		if (local) {
			return this.processPendingLocalBatch(batch);
		}

		// An inbound remote batch should not match the pending batch ID for this client.
		// That would indicate the container forked (two instances trying to submit the same local state)
		if (this.remoteBatchMatchesPendingBatch(batch)) {
			throw DataProcessingError.create(
				"Forked Container Error! Matching batchIds but mismatched clientId",
				"PendingStateManager.processInboundBatch",
				batch.messages[0], // Note: if it's an empty batch, we won't get message metadata added to the error/log here
			);
		}

		// No localOpMetadata for remote messages
		return batch.messages.map((message) => ({ message }));
	}

	/**
	 * Processes the incoming batch from the server that was submitted by this client.
	 * It verifies that messages are received in the right order and that the batch information is correct.
	 * @param batch - The inbound batch (originating from this client) to correlate with the pending local state
	 * @throws DataProcessingError if the pending message content doesn't match the incoming message content for any message in the batch.
	 * @returns The inbound batch's messages with localOpMetadata "zipped" in.
	 */
	private processPendingLocalBatch(batch: InboundBatch): {
		message: InboundSequencedContainerRuntimeMessage;
		localOpMetadata: unknown;
	}[] {
		this.onLocalBatchBegin(batch);

		// Empty batch
		if (batch.messages.length === 0) {
			assert(
				batch.emptyBatchSequenceNumber !== undefined,
				0x9fb /* Expected sequence number for empty batch */,
			);
			const localOpMetadata = this.processNextPendingMessage(batch.emptyBatchSequenceNumber);
			assert(
				asEmptyBatchLocalOpMetadata(localOpMetadata)?.emptyBatch === true,
				0xa20 /* Expected empty batch marker */,
			);
			return [];
		}

		return batch.messages.map((message) => ({
			message,
			localOpMetadata: this.processNextPendingMessage(message.sequenceNumber, message),
		}));
	}

	/**
	 * Processes the pending local copy of message that's been ack'd by the server.
	 * @param sequenceNumber - The sequenceNumber from the server corresponding to the next pending message.
	 * @param message - [optional] The entire incoming message, for comparing contents with the pending message for extra validation.
	 * @throws DataProcessingError if the pending message content doesn't match the incoming message content.
	 * @returns - The localOpMetadata of the next pending message, to be sent to whoever submitted the original message.
	 */
	private processNextPendingMessage(
		sequenceNumber: number,
		message?: InboundSequencedContainerRuntimeMessage,
	): unknown {
		const pendingMessage = this.pendingMessages.peekFront();
		assert(
			pendingMessage !== undefined,
			0x169 /* "No pending message found for this remote message" */,
		);

		pendingMessage.sequenceNumber = sequenceNumber;
		this.savedOps.push(withoutLocalOpMetadata(pendingMessage));

		this.pendingMessages.shift();

		// message is undefined in the Empty Batch case,
		// because we don't have an incoming message to compare and pendingMessage is just a placeholder anyway.
		if (message !== undefined) {
			const messageContent = buildPendingMessageContent(message);

			// Stringified content should match
			if (pendingMessage.content !== messageContent) {
				const pendingContentObj = JSON.parse(
					pendingMessage.content,
				) as LocalContainerRuntimeMessage;
				const incomingContentObj = JSON.parse(
					messageContent,
				) as InboundContainerRuntimeMessage;

				const contentsMatch =
					pendingContentObj.contents === incomingContentObj.contents ||
					(pendingContentObj.contents !== undefined &&
						incomingContentObj.contents !== undefined &&
						JSON.stringify(pendingContentObj.contents) ===
							JSON.stringify(incomingContentObj.contents));

				this.logger.sendErrorEvent({
					eventName: "unexpectedAckReceived",
					details: {
						pendingContentScrubbed: scrubAndStringify(pendingContentObj),
						incomingContentScrubbed: scrubAndStringify(incomingContentObj),
						contentsMatch,
					},
				});

				throw DataProcessingError.create(
					"pending local message content mismatch",
					"unexpectedAckReceived",
					message,
				);
			}
		}

		return pendingMessage.localOpMetadata;
	}

	/**
	 * Check if the incoming batch matches the batch info for the next pending message.
	 */
	private onLocalBatchBegin(batch: InboundBatch) {
		// Get the next message from the pending queue. Verify a message exists.
		const pendingMessage = this.pendingMessages.peekFront();
		assert(
			pendingMessage !== undefined,
			0xa21 /* No pending message found as we start processing this remote batch */,
		);

		// If this batch became empty on resubmit, batch.messages will be empty (so firstMessage undefined)
		// and the next pending message should be an empty batch marker.
		// More Info: We must submit empty batches and track them in case a different fork
		// of this container also submitted the same batch (and it may not be empty for that fork).
		const firstMessage = batch.messages[0];
		const expectedPendingBatchLength =
			pendingMessage.batchInfo.length === -1
				? -1 // Ignore the actual incoming length; -1 length is for back compat so force this to match
				: batch.messages.length === 0
					? 1 // For an empty batch, expect a singleton array with the empty batch marker
					: batch.messages.length; // Otherwise, the lengths should actually match

		// Note: We don't need to use getEffectiveBatchId here, just check the explicit stamped batchID
		// That logic is needed only when comparing across potential container forks.
		// Furthermore, we also are comparing the batch IDs constituent data - clientId (it's local) and batchStartCsn.
		const pendingBatchId = asBatchMetadata(pendingMessage.opMetadata)?.batchId;
		const inboundBatchId = batch.batchId;

		// We expect the incoming batch to be of the same length, starting at the same clientSequenceNumber,
		// as the batch we originally submitted. The batchIds should match as well, if set (or neither should be set)
		// We have another later check to compare the message contents, which we'd expect to fail if this check does,
		// so we don't throw here, merely log.  In a later release this check may replace that one since it's cheaper.
		if (
			pendingMessage.batchInfo.batchStartCsn !== batch.batchStartCsn ||
			pendingMessage.batchInfo.length !== expectedPendingBatchLength ||
			pendingBatchId !== inboundBatchId
		) {
			this.logger?.sendErrorEvent({
				eventName: "BatchInfoMismatch",
				details: {
					pendingBatchCsn: pendingMessage.batchInfo.batchStartCsn,
					batchStartCsn: batch.batchStartCsn,
					pendingBatchLength: pendingMessage.batchInfo.length,
					expectedPendingBatchLength,
					batchLength: batch.messages.length,
					pendingBatchId,
					inboundBatchId,
					pendingMessageBatchMetadata: asBatchMetadata(pendingMessage.opMetadata)?.batch,
					messageBatchMetadata: asBatchMetadata(firstMessage?.metadata)?.batch,
				},
				messageDetails: firstMessage && extractSafePropertiesFromMessage(firstMessage),
			});
		}
	}

	/**
	 * Called when the Container's connection state changes. If the Container gets connected, it replays all the pending
	 * states in its queue. This includes triggering resubmission of unacked ops.
	 * ! Note: successfully resubmitting an op that has been successfully sequenced is not possible due to checks in the ConnectionStateHandler (Loader layer)
	 */
	public replayPendingStates() {
		assert(
			this.stateHandler.connected(),
			0x172 /* "The connection state is not consistent with the runtime" */,
		);

		// This assert suggests we are about to send same ops twice, which will result in data loss.
		assert(
			this.clientIdFromLastReplay !== this.stateHandler.clientId(),
			0x173 /* "replayPendingStates called twice for same clientId!" */,
		);
		this.clientIdFromLastReplay = this.stateHandler.clientId();

		assert(
			this.initialMessages.isEmpty(),
			0x174 /* "initial states should be empty before replaying pending" */,
		);

		const initialPendingMessagesCount = this.pendingMessages.length;
		let remainingPendingMessagesCount = this.pendingMessages.length;

		// Process exactly `pendingMessagesCount` items in the queue as it represents the number of messages that were
		// pending when we connected. This is important because the `reSubmitFn` might add more items in the queue
		// which must not be replayed.
		while (remainingPendingMessagesCount > 0) {
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			let pendingMessage = this.pendingMessages.shift()!;
			remainingPendingMessagesCount--;

			const batchMetadataFlag = asBatchMetadata(pendingMessage.opMetadata)?.batch;
			assert(batchMetadataFlag !== false, 0x41b /* We cannot process batches in chunks */);

			// The next message starts a batch (possibly single-message), and we'll need its batchId.
			const batchId = getEffectiveBatchId(pendingMessage);

			if (asEmptyBatchLocalOpMetadata(pendingMessage.localOpMetadata)?.emptyBatch === true) {
				// Resubmit no messages, with the batchId. Will result in another empty batch marker.
				this.stateHandler.reSubmitBatch([], batchId);
				continue;
			}

			/**
			 * We must preserve the distinct batches on resubmit.
			 * Note: It is not possible for the PendingStateManager to receive a partially acked batch. It will
			 * either receive the whole batch ack or nothing at all.  @see ScheduleManager for how this works.
			 */
			if (batchMetadataFlag === undefined) {
				// Single-message batch

				this.stateHandler.reSubmitBatch(
					[
						{
							content: pendingMessage.content,
							localOpMetadata: pendingMessage.localOpMetadata,
							opMetadata: pendingMessage.opMetadata,
						},
					],
					batchId,
				);
				continue;
			}
			// else: batchMetadataFlag === true  (It's a typical multi-message batch)

			assert(
				remainingPendingMessagesCount > 0,
				0x554 /* Last pending message cannot be a batch begin */,
			);

			const batch: PendingMessageResubmitData[] = [];

			// check is >= because batch end may be last pending message
			while (remainingPendingMessagesCount >= 0) {
				batch.push({
					content: pendingMessage.content,
					localOpMetadata: pendingMessage.localOpMetadata,
					opMetadata: pendingMessage.opMetadata,
				});

				if (pendingMessage.opMetadata?.batch === false) {
					break;
				}
				assert(remainingPendingMessagesCount > 0, 0x555 /* No batch end found */);

				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				pendingMessage = this.pendingMessages.shift()!;
				remainingPendingMessagesCount--;
				assert(
					pendingMessage.opMetadata?.batch !== true,
					0x556 /* Batch start needs a corresponding batch end */,
				);
			}

			this.stateHandler.reSubmitBatch(batch, batchId);
		}

		// pending ops should no longer depend on previous sequenced local ops after resubmit
		this.savedOps = [];

		// We replayPendingStates on read connections too - we expect these to get nack'd though, and to then reconnect
		// on a write connection and replay again. This filters out the replay that happens on the read connection so
		// we only see the replays on write connections (that have a chance to go through).
		if (this.stateHandler.isActiveConnection()) {
			this.logger?.sendTelemetryEvent({
				eventName: "PendingStatesReplayed",
				count: initialPendingMessagesCount,
				clientId: this.stateHandler.clientId(),
			});
		}
	}
}

/** For back-compat if trying to apply stashed ops that pre-date batchInfo */
function patchbatchInfo(
	message: IPendingMessageFromStash,
): asserts message is IPendingMessage {
	const batchInfo: IPendingMessageFromStash["batchInfo"] = message.batchInfo;
	if (batchInfo === undefined) {
		// Using uuid guarantees uniqueness, retaining existing behavior
		message.batchInfo = { clientId: uuid(), batchStartCsn: -1, length: -1 };
	}
}
