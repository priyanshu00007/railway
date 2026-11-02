/*
  Warnings:

  - You are about to drop the column `idNumber` on the `passengers` table. All the data in the column will be lost.
  - Added the required column `gender` to the `passengers` table without a default value. This is not possible if the table is not empty.
  - Added the required column `clientSecret` to the `payments` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
ALTER TYPE "payment_status" ADD VALUE 'REFUNDED';

-- DropForeignKey
ALTER TABLE "payments" DROP CONSTRAINT "payments_bookingId_fkey";

-- AlterTable
ALTER TABLE "passengers" DROP COLUMN "idNumber",
ADD COLUMN     "gender" TEXT NOT NULL,
ADD COLUMN     "seatLabel" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "clientSecret" TEXT NOT NULL,
ADD COLUMN     "holdId" TEXT,
ALTER COLUMN "bookingId" DROP NOT NULL,
ALTER COLUMN "currency" SET DEFAULT 'INR';

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
