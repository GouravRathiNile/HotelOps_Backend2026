// const {
//   StorageSharedKeyCredential,
//   generateBlobSASQueryParameters,
//   BlobSASPermissions
// } = require("@azure/storage-blob");

// const accountName = "hotelopsdevstorage";
// const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;

// const containerName = "itadmin";

// const sharedKeyCredential = new StorageSharedKeyCredential(
//   accountName,
//   accountKey
// );

// function generateUrl(blobName) {
//   const sasToken = generateBlobSASQueryParameters(
//     {
//       containerName,
//       blobName,
//       permissions: BlobSASPermissions.parse("r"),
//       expiresOn: new Date(Date.now() + 60 * 60 * 1000),
//     },
//     sharedKeyCredential
//   ).toString();

//   return `https://${accountName}.blob.core.windows.net/${containerName}/${blobName}?${sasToken}`;
// }

// module.exports = generateUrl;


const accountName = "hotelopsdevstorage";
const containerName = "itadmin";

/**
 * Generate direct Azure Blob Storage URL.
 *
 * Example:
 * generateUrl("OrganizationLogos/example.png")
 *
 * Returns:
 * https://hotelopsdevstorage.blob.core.windows.net/itadmin/OrganizationLogos/example.png
 */
function generateUrl(blobName) {
  if (!blobName) {
    return null;
  }

  // Remove leading "/" to avoid double slash in URL
  const normalizedBlobName = String(blobName).replace(/^\/+/, "");

  return `https://${accountName}.blob.core.windows.net/${containerName}/${normalizedBlobName}`;
}

module.exports = generateUrl;