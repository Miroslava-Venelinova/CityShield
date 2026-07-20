using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace CityShieldAPI.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddReceivesAllAlertsFlag : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "ReceivesAllAlerts",
                table: "Users",
                type: "boolean",
                nullable: false,
                defaultValue: false);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ReceivesAllAlerts",
                table: "Users");
        }
    }
}
