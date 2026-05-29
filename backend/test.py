import psycopg2

from processing import polygon
from config import cfg

city_context = "Варна България"
#bounding_streets = [ 'ул.Орлово гнездо', 'Г.Пеячевич', 'Девня', 'бул.Република']
#bounding_streets = [ 'бул.Владислав', 'Ак.Курчатов', 'ул. Г. Пеячевич', 'ул.Девня']
#bounding_streets = [ 'Д-р Басанович', 'Студентска', 'Под.Калитин', 'Дубровник']
#bounding_streets = [ 'ул. Д-р Басанович', 'ул. Подполковник Калитин', 'ул. Дубровник', 'ул. Студентска']
bounding_streets = [ 'бул Цар Освободител', 'бул Република', 'бул Сливница', 'Вяра']

pg_conn = psycopg2.connect(
    dbname=cfg.POSTGRES_DB,
    user=cfg.POSTGRES_USER,
    password=cfg.POSTGRES_PASSWORD,
    host=cfg.POSTGRES_HOST,
    port=cfg.POSTGRES_PORT,
)

geojson = polygon.streets_to_geojson(city_context, bounding_streets, pg_conn, 200)