-- Question.type: de enum QuestionType a text (ISSUE-15, punto de extensión).
-- Cast in-place con USING para preservar los datos existentes (el DROP+ADD que
-- genera Prisma por defecto es destructivo y además falla en una tabla con
-- filas por el NOT NULL sin default).
ALTER TABLE "Question" ALTER COLUMN "type" SET DATA TYPE TEXT USING "type"::text;

-- DropEnum
DROP TYPE "QuestionType";
