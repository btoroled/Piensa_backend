-- Base de datos separada para la suite de tests / CI (Spec §3, ISSUE-02).
-- Se ejecuta una única vez, al inicializar el volumen de datos por primera vez.
-- La base de datos de desarrollo (piensa_dev) la crea POSTGRES_DB del compose.
CREATE DATABASE piensa_test;
