-- DropForeignKey
ALTER TABLE "Week" DROP CONSTRAINT "Week_gradeId_fkey";

-- DropIndex
DROP INDEX "Week_gradeId_idx";

-- DropIndex
DROP INDEX "Week_gradeId_number_key";

-- AlterTable
ALTER TABLE "Grade" ADD COLUMN     "level" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "Week" DROP COLUMN "gradeId",
ADD COLUMN     "courseId" UUID NOT NULL;

-- CreateTable
CREATE TABLE "Subject" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Course" (
    "id" UUID NOT NULL,
    "subjectId" UUID NOT NULL,
    "gradeId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoursePrerequisite" (
    "courseId" UUID NOT NULL,
    "requiresCourseId" UUID NOT NULL,

    CONSTRAINT "CoursePrerequisite_pkey" PRIMARY KEY ("courseId","requiresCourseId")
);

-- CreateTable
CREATE TABLE "StudentSubject" (
    "studentProfileId" UUID NOT NULL,
    "subjectId" UUID NOT NULL,

    CONSTRAINT "StudentSubject_pkey" PRIMARY KEY ("studentProfileId","subjectId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Subject_name_key" ON "Subject"("name");

-- CreateIndex
CREATE INDEX "Course_subjectId_idx" ON "Course"("subjectId");

-- CreateIndex
CREATE INDEX "Course_gradeId_idx" ON "Course"("gradeId");

-- CreateIndex
CREATE UNIQUE INDEX "Course_subjectId_gradeId_key" ON "Course"("subjectId", "gradeId");

-- CreateIndex
CREATE INDEX "CoursePrerequisite_requiresCourseId_idx" ON "CoursePrerequisite"("requiresCourseId");

-- CreateIndex
CREATE INDEX "StudentSubject_subjectId_idx" ON "StudentSubject"("subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "Grade_level_key" ON "Grade"("level");

-- CreateIndex
CREATE INDEX "Week_courseId_idx" ON "Week"("courseId");

-- CreateIndex
CREATE UNIQUE INDEX "Week_courseId_number_key" ON "Week"("courseId", "number");

-- AddForeignKey
ALTER TABLE "Course" ADD CONSTRAINT "Course_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Course" ADD CONSTRAINT "Course_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "Grade"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoursePrerequisite" ADD CONSTRAINT "CoursePrerequisite_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoursePrerequisite" ADD CONSTRAINT "CoursePrerequisite_requiresCourseId_fkey" FOREIGN KEY ("requiresCourseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentSubject" ADD CONSTRAINT "StudentSubject_studentProfileId_fkey" FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentSubject" ADD CONSTRAINT "StudentSubject_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Week" ADD CONSTRAINT "Week_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

