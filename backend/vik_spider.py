import uuid
from datetime import datetime
from pathlib import Path
import scrapy
from scrapy.crawler import CrawlerProcess


class WaterSpider(scrapy.Spider):
    name = "ViK"
    handle_httpstatus_list = [404]

    custom_settings = {
        "DOWNLOAD_DELAY": 0.3,
        "LOG_LEVEL": "ERROR",
    }

    def start_requests(self):
        base_url = "https://vikvarna.com/bg/messages/breakdown/{}.html"
        for msg_id in range(15000, 15050):
            yield scrapy.Request(
                url=base_url.format(msg_id),
                callback=self.parse,
                dont_filter=True
            )

    def parse(self, response):
        if response.status == 404:
            return

        page_id = int(response.url.split('/')[-1].replace('.html', ''))

        date = response.xpath('//div[@class="list-item-date"]/text()').get()
        message = response.xpath('//div[@class="view"]/p/text()').get()

        if not date or not message:
            return

        yield {
            "id": page_id,
            "date": date.replace('Ð³.', '').strip(),
            "message": message.strip().rstrip(';')
        }


if __name__ == "__main__":
    output_dir = Path(__file__).parent / "vik_json_runs"
    output_dir.mkdir(exist_ok=True)

    run_uuid = uuid.uuid1().hex
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    output_file = output_dir / f"vik_messages_{timestamp}_{run_uuid}.json"

    process = CrawlerProcess(settings={
        "FEEDS": {
            str(output_file): {
                "format": "json",
                "encoding": "utf8",
                "indent": 2,
            }
        }
    })

    process.crawl(WaterSpider)
    process.start()
