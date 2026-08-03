# Architecture

## Core entities

### Part

A part is a master inventory record. It owns the shared quantity and can be linked to any number of projects.

Key fields:

- `id`
- `code`
- `name`
- `category`
- `quantity`
- `length`
- `width`
- `height`
- `assemblyPosition`
- `assemblyTotal`
- `projectIds[]`
- `notes`

### Project

A project is a workspace and contains identity and presentation data. Project membership is held by each part's `projectIds` array.

### Order

An order belongs to one project. Each order item references a master part. Packing an item changes the referenced master part quantity, ensuring all project views remain consistent.

## Persistence

The current storage adapter uses browser `localStorage` and JSON serialization. The UI displays a temporary-mode notice if storage is unavailable.

A cloud version should preserve the same concepts using tables such as:

- `projects`
- `parts`
- `project_parts`
- `orders`
- `order_items`
- `activity`

The many-to-many `project_parts` table replaces the local `projectIds` array.

Legacy `size` strings are migrated in length × width × height order. For example, `680 × 260 × 18` becomes length `680`, width `260` and height `18`.

## Offline behaviour

The service worker caches the static application shell. Operational data remains in local storage, so the current version can continue working without a network connection after its first successful load.
