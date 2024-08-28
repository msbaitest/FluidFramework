/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { assert } from "@fluidframework/core-utils/internal";
import { UsageError } from "@fluidframework/telemetry-utils/internal";

import type { FieldKey } from "../core/index.js";
import {
	FieldKinds,
	type FlexObjectNodeSchema,
	type FlexTreeField,
	type FlexTreeNode,
	type FlexTreeOptionalField,
	type FlexTreeRequiredField,
	getOrCreateMapTreeNode,
	getSchemaAndPolicy,
	isMapTreeNode,
	type MapTreeNode,
} from "../feature-libraries/index.js";
import {
	type InsertableContent,
	getTreeNodeForField,
	prepareContentForHydration,
} from "./proxies.js";
import { getOrCreateInnerNode } from "./proxyBinding.js";
import {
	type ImplicitFieldSchema,
	getStoredKey,
	getExplicitStoredKey,
	type TreeFieldFromImplicitField,
	type InsertableTreeFieldFromImplicitField,
	type FieldSchema,
	normalizeFieldSchema,
	type ImplicitAllowedTypes,
	FieldKind,
} from "./schemaTypes.js";
import {
	type TreeNodeSchema,
	NodeKind,
	type WithType,
	// eslint-disable-next-line import/no-deprecated
	typeNameSymbol,
	typeSchemaSymbol,
	type InternalTreeNode,
	type TreeNode,
} from "./core/index.js";
import { mapTreeFromNodeData } from "./toMapTree.js";
import { type RestrictiveReadonlyRecord, fail, type FlattenKeys } from "../util/index.js";
import { getFlexSchema } from "./toFlexSchema.js";
import type { ObjectNodeSchema, ObjectNodeSchemaInternalData } from "./objectNodeTypes.js";
import { TreeNodeValid, type MostDerivedData } from "./treeNodeValid.js";

/**
 * Helper used to produce types for object nodes.
 * @public
 */
export type ObjectFromSchemaRecord<
	T extends RestrictiveReadonlyRecord<string, ImplicitFieldSchema>,
> = {
	-readonly [Property in keyof T]: TreeFieldFromImplicitField<T[Property]>;
};

/**
 * A {@link TreeNode} which modules a JavaScript object.
 * @remarks
 * Object nodes consist of a type which specifies which {@link TreeNodeSchema} they use (see {@link TreeNodeApi.schema}), and a collections of fields, each with a distinct `key` and its own {@link FieldSchema} defining what can be placed under that key.
 *
 * All fields on an object node are exposed as own properties with string keys.
 * Non-empty fields are enumerable and empty optional fields are non-enumerable own properties with the value `undefined`.
 * No other own `own` or `enumerable` properties are included on object nodes unless the user of the node manually adds custom session only state.
 * This allows a majority of general purpose JavaScript object processing operations (like `for...in`, `Reflect.ownKeys()` and `Object.entries()`) to enumerate all the children.
 * @public
 */
export type TreeObjectNode<
	T extends RestrictiveReadonlyRecord<string, ImplicitFieldSchema>,
	TypeName extends string = string,
> = TreeNode & ObjectFromSchemaRecord<T> & WithType<TypeName, NodeKind.Object>;

/**
 * Type utility for determining whether or not an implicit field schema has a default value.
 *
 * @privateRemarks
 * TODO: Account for field schemas with default value providers.
 * For now, this only captures field kinds that we know always have defaults - optional fields and identifier fields.
 *
 * @public
 */
export type FieldHasDefault<T extends ImplicitFieldSchema> = T extends FieldSchema<
	FieldKind.Optional | FieldKind.Identifier
>
	? true
	: false;

/**
 * Helper used to produce types for:
 *
 * 1. Insertable content which can be used to construct an object node.
 *
 * 2. Insertable content which is an unhydrated object node.
 *
 * 3. Union of 1 and 2.
 *
 * @privateRemarks TODO: consider separating these cases into different types.
 *
 * @public
 */
export type InsertableObjectFromSchemaRecord<
	T extends RestrictiveReadonlyRecord<string, ImplicitFieldSchema>,
> = FlattenKeys<
	{
		readonly [Property in keyof T]?: InsertableTreeFieldFromImplicitField<T[Property]>;
	} & {
		// Field does not have a known default, make it required:
		readonly [Property in keyof T as FieldHasDefault<T[Property]> extends false
			? Property
			: never]: InsertableTreeFieldFromImplicitField<T[Property]>;
	}
>;

/**
 * Maps from simple field keys ("view" keys) to information about the field.
 *
 * @remarks
 * A missing entry for a given view key indicates that no such field exists.
 * Keys with symbols are currently never used, but allowed to make lookups on non-field things
 * (returning undefined) easier.
 */
export type SimpleKeyMap = ReadonlyMap<
	string | symbol,
	{ storedKey: FieldKey; schema: FieldSchema }
>;

/**
 * Caches the mappings from view keys to stored keys for the provided object field schemas in {@link simpleKeyToFlexKeyCache}.
 */
function createFlexKeyMapping(fields: Record<string, ImplicitFieldSchema>): SimpleKeyMap {
	const keyMap: Map<string | symbol, { storedKey: FieldKey; schema: FieldSchema }> = new Map();
	for (const [viewKey, fieldSchema] of Object.entries(fields)) {
		const storedKey = getStoredKey(viewKey, fieldSchema);
		keyMap.set(viewKey, { storedKey, schema: normalizeFieldSchema(fieldSchema) });
	}

	return keyMap;
}

/**
 * @param allowAdditionalProperties - If true, setting of unexpected properties will be forwarded to the target object.
 * Otherwise setting of unexpected properties will error.
 * TODO: consider implementing this using `Object.preventExtension` instead.
 * @param customTargetObject - Target object of the proxy.
 * If not provided `{}` is used for the target.
 */
function createProxyHandler(
	flexKeyMap: SimpleKeyMap,
	allowAdditionalProperties: boolean,
): ProxyHandler<TreeNode> {
	// To satisfy 'deepEquals' level scrutiny, the target of the proxy must be an object with the same
	// prototype as an object literal '{}'.  This is because 'deepEquals' uses 'Object.getPrototypeOf'
	// as a way to quickly reject objects with different prototype chains.
	//
	// (Note that the prototype of an object literal appears as '[Object: null prototype] {}', not because
	// the prototype is null, but because the prototype object itself has a null prototype.)

	// TODO: Although the target is an object literal, it's still worthwhile to try experimenting with
	// a dispatch object to see if it improves performance.
	const handler: ProxyHandler<TreeNode> = {
		get(target, viewKey, proxy): unknown {
			const fieldInfo = flexKeyMap.get(viewKey);

			if (fieldInfo !== undefined) {
				const flexNode = getOrCreateInnerNode(proxy);
				const field = flexNode.tryGetField(fieldInfo.storedKey);
				if (field !== undefined) {
					return getTreeNodeForField(field);
				}

				// Check if the user is trying to read an identifier field of an unhydrated node, but the identifier is not present.
				// This means the identifier is an "auto-generated identifier", because otherwise it would have been supplied by the user at construction time and would have been successfully read just above.
				// In this case, it is categorically impossible to provide an identifier (auto-generated identifiers can't be created until hydration/insertion time), so we emit an error.
				if (fieldInfo.schema.kind === FieldKind.Identifier && isMapTreeNode(flexNode)) {
					throw new UsageError(
						"An automatically generated node identifier may not be queried until the node is inserted into the tree",
					);
				}

				return undefined;
			}

			// Pass the proxy as the receiver here, so that any methods on the prototype receive `proxy` as `this`.
			return Reflect.get(target, viewKey, proxy);
		},
		set(target, viewKey, value: InsertableContent | undefined, proxy) {
			const fieldInfo = flexKeyMap.get(viewKey);
			if (fieldInfo === undefined) {
				// Pass the proxy as the receiver here, so that setters on the prototype receive `proxy` as `this`.
				return allowAdditionalProperties ? Reflect.set(target, viewKey, value, proxy) : false;
			}

			setField(
				getOrCreateInnerNode(proxy).getBoxed(fieldInfo.storedKey),
				fieldInfo.schema,
				value,
			);
			return true;
		},
		deleteProperty(target, viewKey): boolean {
			// TODO: supporting delete when it makes sense (custom local fields, and optional field) could be added as a feature in the future.
			throw new UsageError(
				`Object nodes do not support the delete operator. Optional fields can be assigned to undefined instead.`,
			);
		},
		has: (target, viewKey) => {
			return (
				flexKeyMap.has(viewKey) ||
				(allowAdditionalProperties ? Reflect.has(target, viewKey) : false)
			);
		},
		ownKeys: (target) => {
			return [
				...flexKeyMap.keys(),
				...(allowAdditionalProperties ? Reflect.ownKeys(target) : []),
			];
		},
		getOwnPropertyDescriptor: (target, viewKey) => {
			const fieldInfo = flexKeyMap.get(viewKey);

			if (fieldInfo === undefined) {
				return allowAdditionalProperties
					? Reflect.getOwnPropertyDescriptor(target, viewKey)
					: undefined;
			}

			// For some reason, the getOwnPropertyDescriptor is not passed in the receiver, so use a weak map.
			// If a refactoring is done to associated flex tree data with the target not the proxy, this extra map could be removed,
			// and the design would be more compatible with proxyless nodes.
			const proxy = targetToProxy.get(target) ?? fail("missing proxy");
			const field = getOrCreateInnerNode(proxy).tryGetField(fieldInfo.storedKey);

			const p: PropertyDescriptor = {
				value: field === undefined ? undefined : getTreeNodeForField(field),
				writable: true,
				// Report empty fields as own properties so they shadow inherited properties (even when empty) to match TypeScript typing.
				// Make empty fields not enumerable so they get skipped when iterating over an object to better align with
				// JSON and deep equals with JSON compatible object (which can't have undefined fields).
				enumerable: field !== undefined,
				configurable: true, // Must be 'configurable' if property is absent from proxy target.
			};

			return p;
		},
	};
	return handler;
}

export function setField(
	field: FlexTreeField,
	simpleFieldSchema: FieldSchema,
	value: InsertableContent | undefined,
): void {
	const mapTree = mapTreeFromNodeData(
		value,
		simpleFieldSchema,
		field.context?.nodeKeyManager,
		getSchemaAndPolicy(field),
	);

	if (field.context !== undefined) {
		prepareContentForHydration(mapTree, field.context.checkout.forest);
	}

	switch (field.schema.kind) {
		case FieldKinds.required: {
			assert(mapTree !== undefined, 0xa04 /* Cannot set a required field to undefined */);
			const typedField = field as FlexTreeRequiredField;
			typedField.editor.set(mapTree);
			break;
		}
		case FieldKinds.optional: {
			const typedField = field as FlexTreeOptionalField;
			typedField.editor.set(mapTree, typedField.length === 0);
			break;
		}

		default:
			fail("invalid FieldKind");
	}
}

abstract class CustomObjectNodeBase<
	const T extends RestrictiveReadonlyRecord<string, ImplicitFieldSchema>,
> extends TreeNodeValid<InsertableObjectFromSchemaRecord<T>> {
	public static readonly kind = NodeKind.Object;
}

/**
 * Define a {@link TreeNodeSchema} for a {@link TreeObjectNode}.
 *
 * @param name - Unique identifier for this schema within this factory's scope.
 * @param fields - Schema for fields of the object node's schema. Defines what children can be placed under each key.
 */
export function objectSchema<
	TName extends string,
	const T extends RestrictiveReadonlyRecord<string, ImplicitFieldSchema>,
	const ImplicitlyConstructable extends boolean,
>(
	identifier: TName,
	info: T,
	implicitlyConstructable: ImplicitlyConstructable,
): ObjectNodeSchema<TName, T, ImplicitlyConstructable> & ObjectNodeSchemaInternalData {
	// Ensure no collisions between final set of view keys, and final set of stored keys (including those
	// implicitly derived from view keys)
	assertUniqueKeys(identifier, info);

	// Performance optimization: cache view key => stored key and schema.
	const flexKeyMap: SimpleKeyMap = createFlexKeyMapping(info);

	let handler: ProxyHandler<object>;
	let customizable: boolean;
	let flexSchema: FlexObjectNodeSchema;

	class CustomObjectNode extends CustomObjectNodeBase<T> {
		public static readonly fields: ReadonlyMap<string, FieldSchema> = new Map(
			Array.from(flexKeyMap, ([key, value]) => [key as string, value.schema]),
		);
		public static readonly flexKeyMap: SimpleKeyMap = flexKeyMap;
		public static readonly storedKeyToPropertyKey: ReadonlyMap<FieldKey, string> = new Map<
			FieldKey,
			string
		>(
			Array.from(flexKeyMap, ([key, value]): [FieldKey, string] => [
				value.storedKey,
				key as string,
			]),
		);

		public static override prepareInstance<T2>(
			this: typeof TreeNodeValid<T2>,
			instance: TreeNodeValid<T2>,
			flexNode: FlexTreeNode,
		): TreeNodeValid<T2> {
			// Differentiate between the following cases:
			//
			// Case 1: Direct construction (POJO emulation)
			//
			//     const Foo = schemaFactory.object("Foo", {bar: schemaFactory.number});
			//
			//     assert.deepEqual(new Foo({ bar: 42 }), { bar: 42 },
			//		   "Prototype chain equivalent to POJO.");
			//
			// Case 2: Subclass construction (Customizable Object)
			//
			// 	   class Foo extends schemaFactory.object("Foo", {bar: schemaFactory.number}) {}
			//
			// 	   assert.notDeepEqual(new Foo({ bar: 42 }), { bar: 42 },
			// 	       "Subclass prototype chain differs from POJO.");
			//
			// In Case 1 (POJO emulation), the prototype chain match '{}' (proxyTarget = undefined)
			// In Case 2 (Customizable Object), the prototype chain include the user's subclass (proxyTarget = this)

			const proxyTarget = customizable ? instance : {};
			const proxy = new Proxy(proxyTarget, handler) as CustomObjectNode;
			targetToProxy.set(proxyTarget, proxy);
			return proxy;
		}

		public static override buildRawNode<T2>(
			this: typeof TreeNodeValid<T2>,
			instance: TreeNodeValid<T2>,
			input: T2,
		): MapTreeNode {
			return getOrCreateMapTreeNode(
				flexSchema,
				mapTreeFromNodeData(input as object, this as unknown as ImplicitAllowedTypes),
			);
		}

		protected static override constructorCached: MostDerivedData | undefined = undefined;

		protected static override oneTimeSetup<T2>(this: typeof TreeNodeValid<T2>): void {
			// One time initialization that required knowing the most derived type (from this.constructor) and thus has to be lazy.
			customizable = (this as unknown) !== CustomObjectNode;
			handler = createProxyHandler(flexKeyMap, customizable);
			flexSchema = getFlexSchema(this as unknown as TreeNodeSchema) as FlexObjectNodeSchema;

			// First run, do extra validation.
			// TODO: provide a way for TreeConfiguration to trigger this same validation to ensure it gets run early.
			// Scan for shadowing inherited members which won't work, but stop scan early to allow shadowing built in (which seems to work ok).
			{
				let prototype: object = this.prototype;
				// There isn't a clear cleaner way to author this loop.
				while (prototype !== CustomObjectNode.prototype) {
					for (const [key] of flexKeyMap) {
						if (
							// constructor is a special case, since one is built in on the derived type, and shadowing it works fine since we only use it before fields are applied.
							key !== "constructor" &&
							Reflect.getOwnPropertyDescriptor(prototype, key) !== undefined
						) {
							throw new UsageError(
								`Schema ${identifier} defines an inherited property "${key.toString()}" which shadows a field. Since fields are exposed as own properties, this shadowing will not work, and is an error.`,
							);
						}
					}
					// Since this stops at CustomObjectNode, it should never see a null prototype, so this case is safe.
					// Additionally, if the prototype chain is ever messed up such that CustomObjectNode is not in it,
					// the null that would show up here does at least ensure this code throws instead of hanging.
					prototype = Reflect.getPrototypeOf(prototype) as object;
				}
			}
		}

		public static readonly identifier = identifier;
		public static readonly info = info;
		public static readonly implicitlyConstructable: ImplicitlyConstructable =
			implicitlyConstructable;

		// eslint-disable-next-line import/no-deprecated
		public get [typeNameSymbol](): TName {
			return identifier;
		}
		public get [typeSchemaSymbol](): Output {
			return CustomObjectNode.constructorCached?.constructor as unknown as Output;
		}
	}
	type Output = typeof CustomObjectNode &
		(new (
			input: InsertableObjectFromSchemaRecord<T> | InternalTreeNode,
		) => TreeObjectNode<T, TName>);
	return CustomObjectNode as Output;
}

const targetToProxy: WeakMap<object, TreeNode> = new WeakMap();

/**
 * Ensures that the set of view keys in the schema is unique.
 * Also ensure that the final set of stored keys (including those implicitly derived from view keys) is unique.
 * @throws Throws a `UsageError` if either of the key uniqueness invariants is violated.
 */
function assertUniqueKeys<
	const Name extends number | string,
	const Fields extends RestrictiveReadonlyRecord<string, ImplicitFieldSchema>,
>(schemaName: Name, fields: Fields): void {
	// Verify that there are no duplicates among the explicitly specified stored keys.
	const explicitStoredKeys = new Set<string>();
	for (const schema of Object.values(fields)) {
		const storedKey = getExplicitStoredKey(schema);
		if (storedKey === undefined) {
			continue;
		}
		if (explicitStoredKeys.has(storedKey)) {
			throw new UsageError(
				`Duplicate stored key "${storedKey}" in schema "${schemaName}". Stored keys must be unique within an object schema.`,
			);
		}
		explicitStoredKeys.add(storedKey);
	}

	// Verify that there are no duplicates among the derived
	// (including those implicitly derived from view keys) stored keys.
	const derivedStoredKeys = new Set<string>();
	for (const [viewKey, schema] of Object.entries(fields)) {
		const storedKey = getStoredKey(viewKey, schema);
		if (derivedStoredKeys.has(storedKey)) {
			throw new UsageError(
				`Stored key "${storedKey}" in schema "${schemaName}" conflicts with a property key of the same name, which is not overridden by a stored key. The final set of stored keys in an object schema must be unique.`,
			);
		}
		derivedStoredKeys.add(storedKey);
	}
}
