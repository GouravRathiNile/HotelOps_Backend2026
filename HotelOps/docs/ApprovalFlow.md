# Approval Flow Builder API

Base path: `/api/ApprovalFlow`. All requests require bearer authentication.
`OrganizationID` is mandatory for every operation. Body/query IDs accept positive
integers or numeric strings. Responses retain the existing lowercase database
field names; request fields use PascalCase.

| Method | Path | Operation |
| --- | --- | --- |
| POST | /save | Create or update a complete flow, including IsActive |
| GET | /list | Paginated master records with complete active approval levels |
| DELETE | /delete | Soft-delete a flow in the supplied organization |

Removed: POST /create, PUT /update, GET /details/:ApprovalMasterID, PATCH /status.
Queue actions are now SAVE_APPROVAL_FLOW, GET_APPROVAL_FLOW_LIST and
DELETE_APPROVAL_FLOW. Deploy API and consumer together; old clients and queued
legacy actions must be migrated before removing the old deployment.

## Save

Body fields: OrganizationID, optional ApprovalMasterID, FlowName, ModuleName,
optional Description, optional IsActive, and Details (a nonempty array).
FlowName and ModuleName must be nonblank strings. Details retain the existing
Level, ApproverType, Role, ApprovalType and optional IsMandatory fields and their
existing domain values. IsMandatory defaults to true and must be boolean when
provided. Actor/audit IDs come from the authenticated user.

Omitting ApprovalMasterID (or supplying null, an empty string, or whitespace) creates a flow and returns HTTP
201. Supplying a positive ApprovalMasterID updates that non-deleted flow in the
given organization and returns HTTP 200. An unknown or cross-organization ID
returns HTTP 404; it never creates a replacement.

IsActive must be a JSON boolean. It defaults to true on create; omission on
update preserves the current value. To activate/deactivate, send the full flow
with the desired IsActive value. This is a full save, not a partial patch:
Details replaces the previous active levels, preserving soft-deleted history.
Omitted/blank Description is saved as null. The existing one-flow-per-module
check applies within the organization (HTTP 409 for duplicates).

Master and detail changes commit in one transaction. Save returns:
```json
{
  "success": true,
  "statusCode": 201,
  "message": "Approval Flow Created Successfully",
  "ApprovalMasterID": 7,
  "data": {
    "organizationid": 2,
    "approvalmasterid": 7,
    "flowname": "Gatepass approvals",
    "modulename": "Gatepass",
    "description": "Department and finance approvals",
    "isactive": true,
    "createdby": 9,
    "createddatetime": "2026-10-08T10:00:00.000Z",
    "modifiedby": null,
    "modifieddatetime": null,
    "details": [
      {
        "approvalid": 11,
        "approvalmasterid": 7,
        "level": 1,
        "approvertype": "Role",
        "role": "HOD",
        "approvaltype": "Sequential",
        "ismandatory": true,
        "createdby": 9,
        "createddatetime": "2026-10-08T10:00:00.000Z",
        "modifiedby": null,
        "modifieddatetime": null
      }
    ]
  }
}
```
Update uses statusCode 200 and message "Approval Flow Updated Successfully".
Database bigint IDs may serialize as strings.

## List

Query: required OrganizationID; optional ApprovalMasterID, FlowName, ModuleName,
IsActive (true/false), page (default 1), PageSize (default 10).
FlowName/ModuleName retain case-insensitive substring matching. Pagination and
TotalCount apply to masters, not approval levels. Only non-deleted masters and
levels are returned; inactive masters remain visible unless filtered.
Each master includes only approvalmasterid, organizationid, flowname, modulename,
description, isactive, createddatetime and details. Each detail includes only
role, level, ismandatory, approvaltype, approvertype and createddatetime.
Details are sorted by level then internal approvalid (not exposed); no levels
yields an empty array. Pagination fields are unchanged.

```json
{
  "success": true,
  "message": "Approval Flow List fetched successfully",
  "TotalCount": 1,
  "PageCount": 1,
  "CurrentPage": 1,
  "PageSize": 10,
  "TotalPages": 1,
  "data": [
    {
      "organizationid": 2,
      "approvalmasterid": 7,
      "flowname": "Gatepass approvals",
      "modulename": "Gatepass",
      "description": "Department and finance approvals",
      "isactive": true,
      "createddatetime": "2026-10-08T10:00:00.000Z",
      "details": [
        {
          "level": 1,
          "approvertype": "Role",
          "role": "HOD",
          "approvaltype": "Sequential",
          "ismandatory": true,
          "createddatetime": "2026-10-08T10:00:00.000Z"
        }
      ]
    }
  ]
}
```

Use the optional ApprovalMasterID filter in List instead of the former Details
API. An unmatched ID returns an empty paginated list.

## Delete and errors

DELETE body requires OrganizationID and ApprovalMasterID. Success returns
HTTP 200 with `{"success":true,"message":"Approval Flow Deleted Successfully"}`.
A missing/deleted/cross-organization master returns 404.

Validation errors return HTTP 400; unexpected errors return 500. Error shape:
`{"success":false,"message":"..."}`. Existing transient database retry handling
is retained. No new schema or queue mapping is required.

Import [ApprovalFlow.postman_collection.json](./ApprovalFlow.postman_collection.json).
Set baseUrl, token, OrganizationID and existing approval-type values before use.
The create/update response examples use illustrative role/type values.

