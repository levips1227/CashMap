import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TEMPLATE_PATH = PROJECT_ROOT / "public" / "budget-transaction-import-template.xlsx"
SHEET_PATH = "xl/worksheets/sheet2.xml"
XML_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"

ET.register_namespace("", XML_NS)


def quoted_csv(values):
    return '"' + ",".join(values) + '"'


def main():
    with zipfile.ZipFile(TEMPLATE_PATH, "r") as archive:
        files = {name: archive.read(name) for name in archive.namelist()}

    root = ET.fromstring(files[SHEET_PATH])
    ns = {"x": XML_NS}

    validations = root.find("x:dataValidations", ns)
    if validations is None:
        raise RuntimeError("Template workbook is missing the dataValidations container.")

    expected = [
        ("C2:C500", ["income", "expense", "transfer"], "Invalid direction", "Choose income, expense, or transfer from the dropdown."),
        (
            "H2:H500",
            [
                "Payroll",
                "Rent / Mortgage",
                "Utilities",
                "Insurance",
                "Groceries",
                "Dining",
                "Fuel",
                "Transfer",
                "Debt Payment",
                "Savings",
                "Subscription",
                "Medical",
                "Travel",
                "Shopping",
                "Other",
            ],
            "Invalid category",
            "Choose one of the template categories from the dropdown.",
        ),
    ]

    for node, (sqref, options, title, message) in zip(list(validations), expected):
        node.clear()
        node.attrib.update(
            {
                "type": "list",
                "allowBlank": "1",
                "showErrorMessage": "1",
                "errorStyle": "stop",
                "errorTitle": title,
                "error": message,
                "sqref": sqref,
            }
        )
        formula = ET.SubElement(node, f"{{{XML_NS}}}formula1")
        formula.text = quoted_csv(options)

    validations.set("count", str(len(expected)))
    files[SHEET_PATH] = ET.tostring(root, encoding="utf-8", xml_declaration=True)

    with zipfile.ZipFile(TEMPLATE_PATH, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            archive.writestr(name, data)

    print(f"Patched dropdown validations in {TEMPLATE_PATH}")


if __name__ == "__main__":
    main()
