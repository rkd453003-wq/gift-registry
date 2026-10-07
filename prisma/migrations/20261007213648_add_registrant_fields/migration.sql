/*
  Warnings:

  - Added the required column `registrantEmail` to the `Registry` table without a default value. This is not possible if the table is not empty.
  - Added the required column `registrantName` to the `Registry` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Registry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "customerId" TEXT,
    "registrantName" TEXT NOT NULL,
    "registrantEmail" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventDate" DATETIME,
    "slug" TEXT NOT NULL,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Registry" ("createdAt", "customerId", "eventDate", "eventType", "id", "isPublic", "shop", "slug", "title", "updatedAt") SELECT "createdAt", "customerId", "eventDate", "eventType", "id", "isPublic", "shop", "slug", "title", "updatedAt" FROM "Registry";
DROP TABLE "Registry";
ALTER TABLE "new_Registry" RENAME TO "Registry";
CREATE INDEX "Registry_shop_customerId_idx" ON "Registry"("shop", "customerId");
CREATE UNIQUE INDEX "Registry_shop_slug_key" ON "Registry"("shop", "slug");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
