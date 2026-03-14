module pacific_avatar::avatar;

use std::string::{Self as string, String};
use std::type_name;
use sui::display;
use sui::dynamic_object_field as dof;
use sui::event;
use sui::package;

const E_CHILD_SLOT_EXISTS: u64 = 0;
const E_CHILD_SLOT_DOES_NOT_EXIST: u64 = 1;

public struct AVATAR has drop {}

public struct Avatar has key, store {
    id: UID,
    name: String,
    description: String,
    manifest_blob_id: String,
    preview_blob_id: String,
    preview_url: String,
    project_url: String,
    schema_version: u64,
}

public struct AvatarChildSlot has copy, drop, store {
    name: String,
}

public struct AvatarMinted has copy, drop {
    avatar_id: address,
    owner: address,
    manifest_blob_id: String,
    preview_blob_id: String,
    schema_version: u64,
}

public struct AvatarUpdated has copy, drop {
    avatar_id: address,
    owner: address,
    manifest_blob_id: String,
    preview_blob_id: String,
    schema_version: u64,
}

public struct AvatarChildAttached has copy, drop {
    avatar_id: address,
    owner: address,
    child_object_id: address,
    field_name: String,
    child_type: String,
}

public struct AvatarChildDetached has copy, drop {
    avatar_id: address,
    owner: address,
    child_object_id: address,
    field_name: String,
    child_type: String,
}

#[allow(lint(share_owned))]
fun init(witness: AVATAR, ctx: &mut TxContext) {
    let publisher = package::claim(witness, ctx);
    let mut avatar_display = display::new_with_fields<Avatar>(
        &publisher,
        vector[
            string::utf8(b"name"),
            string::utf8(b"description"),
            string::utf8(b"image"),
            string::utf8(b"link"),
        ],
        vector[
            string::utf8(b"{name}"),
            string::utf8(b"{description}"),
            string::utf8(b"{preview_url}"),
            string::utf8(b"{project_url}"),
        ],
        ctx,
    );

    display::update_version(&mut avatar_display);
    transfer::public_share_object(avatar_display);
    transfer::public_transfer(publisher, ctx.sender());
}

#[allow(lint(self_transfer))]
public fun mint(
    name: String,
    description: String,
    manifest_blob_id: String,
    preview_blob_id: String,
    preview_url: String,
    project_url: String,
    schema_version: u64,
    ctx: &mut TxContext,
) {
    let owner = ctx.sender();
    let avatar = Avatar {
        id: object::new(ctx),
        name,
        description,
        manifest_blob_id,
        preview_blob_id,
        preview_url,
        project_url,
        schema_version,
    };

    event::emit(AvatarMinted {
        avatar_id: object::id(&avatar).to_address(),
        owner,
        manifest_blob_id: avatar.manifest_blob_id,
        preview_blob_id: avatar.preview_blob_id,
        schema_version: avatar.schema_version,
    });

    transfer::public_transfer(avatar, owner);
}

public fun update(
    avatar: &mut Avatar,
    name: String,
    description: String,
    manifest_blob_id: String,
    preview_blob_id: String,
    preview_url: String,
    project_url: String,
    schema_version: u64,
    ctx: &TxContext,
) {
    avatar.name = name;
    avatar.description = description;
    avatar.manifest_blob_id = manifest_blob_id;
    avatar.preview_blob_id = preview_blob_id;
    avatar.preview_url = preview_url;
    avatar.project_url = project_url;
    avatar.schema_version = schema_version;

    event::emit(AvatarUpdated {
        avatar_id: object::id(avatar).to_address(),
        owner: ctx.sender(),
        manifest_blob_id: avatar.manifest_blob_id,
        preview_blob_id: avatar.preview_blob_id,
        schema_version: avatar.schema_version,
    });
}

public fun attach_child<T: key + store>(
    avatar: &mut Avatar,
    field_name: String,
    child: T,
    ctx: &TxContext,
) {
    let slot = AvatarChildSlot { name: field_name };
    assert!(!dof::exists_(&avatar.id, slot), E_CHILD_SLOT_EXISTS);

    let child_id = object::id(&child);
    let child_type = string::utf8(type_name::with_original_ids<T>().into_string().into_bytes());
    dof::add(&mut avatar.id, slot, child);

    event::emit(AvatarChildAttached {
        avatar_id: object::id(avatar).to_address(),
        owner: ctx.sender(),
        child_object_id: child_id.to_address(),
        field_name: slot.name,
        child_type,
    });
}

public fun detach_child<T: key + store>(
    avatar: &mut Avatar,
    field_name: String,
    recipient: address,
    ctx: &TxContext,
) {
    let slot = AvatarChildSlot { name: field_name };
    assert!(dof::exists_with_type<AvatarChildSlot, T>(&avatar.id, slot), E_CHILD_SLOT_DOES_NOT_EXIST);

    let child = dof::remove<AvatarChildSlot, T>(&mut avatar.id, slot);
    let child_id = object::id(&child);
    let child_type = string::utf8(type_name::with_original_ids<T>().into_string().into_bytes());

    event::emit(AvatarChildDetached {
        avatar_id: object::id(avatar).to_address(),
        owner: ctx.sender(),
        child_object_id: child_id.to_address(),
        field_name: slot.name,
        child_type,
    });

    transfer::public_transfer(child, recipient);
}

public fun manifest_blob_id(avatar: &Avatar): &String {
    &avatar.manifest_blob_id
}

public fun preview_blob_id(avatar: &Avatar): &String {
    &avatar.preview_blob_id
}

public fun preview_url(avatar: &Avatar): &String {
    &avatar.preview_url
}

public fun project_url(avatar: &Avatar): &String {
    &avatar.project_url
}

public fun schema_version(avatar: &Avatar): u64 {
    avatar.schema_version
}
