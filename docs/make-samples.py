"""Builds the demo PDFs used for the README screenshots: docs/samples/spaced-practice.pdf and
docs/samples/间隔练习与长期记忆.pdf.

Both have the same layout: a short paper (page 1), a figure, table and equation (page 2), and a
consent form with live fields (page 3). Run with `python3 docs/make-samples.py` (needs reportlab;
the Chinese file uses the macOS Songti and STHeiti fonts).
"""

from pathlib import Path

from reportlab.lib.colors import HexColor, black, white
from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

HERE = Path(__file__).parent / "samples"
W, H = letter
LEFT = 72
RIGHT = W - 72

EN = {
    "file": "spaced-practice.pdf",
    "title": "Spaced practice and long-term recall",
    "byline": "L. Moreau, K. Tanaka  ·  Working paper, 2026",
    "abstract_h": "Abstract",
    "abstract": "We compare spaced and massed practice in 120 first-year students learning the same biology vocabulary. Students who spread four short sessions over two weeks recalled 71% of the terms after 30 days, against 38% for students who studied in one block. Figure 1 shows recall over time and Table 1 gives the scores. Section 2 describes the method. The forgetting model follows earlier work [1].",
    "intro_h": "1 Introduction",
    "intro": [
        "Memory fades quickly after a single study session. A common description is the forgetting curve, where the share of material retained after t days follows R(t) = e^(-t/S). Here S is the stability of the memory: the larger S, the slower the decline. Equation (1) on the next page gives the fitted form.",
        "Reviewing material at growing intervals is thought to raise S with each session, so later reviews can be further apart. This spacing effect is well documented in the laboratory [2], but less is known about its size in an ordinary course with real deadlines.",
    ],
    "rq_h": "1.1 Research question",
    "rq": "Does spreading the same total study time over two weeks improve recall one month later, and by how much? We also ask whether the benefit holds for students with lower prior grades.",
    "method_h": "2 Method and results",
    "method": "Students were randomly assigned to a spaced group (four 20-minute sessions on days 0, 2, 6 and 13) or a massed group (one 80-minute session on day 0). Both groups took the same recall test on days 1, 7, 14 and 30.",
    "axis": ["Day 1", "Day 7", "Day 14", "Day 30"],
    "legend": ["Spaced", "Massed"],
    "fig_caption": "Figure 1: Share of terms recalled by each group, from day 1 to day 30.",
    "table_caption": "Table 1: Mean recall (%) by test day.",
    "table_head": ["Test day", "Spaced", "Massed", "Difference"],
    "equation": "R(t) = e^(-t/S)",
    "fit": "Equation (1) is fitted to each group's scores by least squares. Stability S is 86 days for the spaced group and 31 days for the massed group, so spaced practice slowed forgetting by a factor of about 2.8.",
    "form_h": "3 Participant consent form",
    "form_intro": "Please complete this form before your first session. Fields marked * are required.",
    "labels": ["Full name *", "Date of birth (DD/MM/YYYY) *", "Email *", "Phone", "Faculty", "Preferred session", "I agree to take part *", "Signature *", "Date *"],
    "session": ["Morning", "Afternoon"],
    "faculties": ["Science", "Arts", "Medicine", "Engineering"],
    "refs_h": "References",
    "refs": [
        "[1] R. Alvarez and J. Singh. Modelling forgetting in classroom settings. Journal of Learning Research, 8(2):101-118, 2022.",
        "[2] M. Okafor. Spacing effects in the laboratory: a review. Memory Studies, 14:1-29, 2019.",
    ],
}

ZH = {
    "file": "间隔练习与长期记忆.pdf",
    "title": "间隔练习与长期记忆",
    "byline": "L. Moreau、K. Tanaka  ·  工作论文，2026",
    "abstract_h": "摘要",
    "abstract": "本文比较了间隔练习与集中练习对 120 名大一学生学习同一批生物学词汇的效果。把四次短时学习分散在两周内完成的学生，30 天后能回忆起 71% 的术语；一次性集中学习的学生只有 38%。图 1 展示了回忆率随时间的变化，表 1 列出了各测试日的得分，第 2 节介绍研究方法。遗忘模型沿用了已有研究 [1]。",
    "intro_h": "1 引言",
    "intro": [
        "单次学习之后，记忆会迅速衰退。常见的描述是遗忘曲线：t 天后保留的内容比例满足 R(t) = e^(-t/S)，其中 S 表示记忆的稳定性，S 越大，遗忘越慢。下一页的式 (1) 给出了拟合形式。",
        "一般认为，以逐渐拉长的间隔复习，每次都能提高 S，因此之后的复习可以相隔更久。这种间隔效应在实验室中已有充分证据 [2]，但在有真实截止日期的普通课程中，其效果有多大仍不清楚。",
    ],
    "rq_h": "1.1 研究问题",
    "rq": "把相同的总学习时间分散到两周内，能否提高一个月后的回忆率？提高多少？我们还考察了这一益处对先前成绩较低的学生是否同样成立。",
    "method_h": "2 方法与结果",
    "method": "学生被随机分为间隔组（在第 0、2、6、13 天各学习 20 分钟）和集中组（第 0 天一次学习 80 分钟）。两组在第 1、7、14、30 天参加相同的回忆测试。",
    "axis": ["第 1 天", "第 7 天", "第 14 天", "第 30 天"],
    "legend": ["间隔组", "集中组"],
    "fig_caption": "图 1：两组在第 1 天至第 30 天回忆出的术语比例。",
    "table_caption": "表 1：各测试日的平均回忆率（%）。",
    "table_head": ["测试日", "间隔组", "集中组", "差值"],
    "equation": "R(t) = e^(-t/S)",
    "fit": "式 (1) 用最小二乘法分别拟合两组得分。间隔组的稳定性 S 为 86 天，集中组为 31 天，即间隔练习使遗忘速度减慢约 2.8 倍。",
    "form_h": "3 研究参与知情同意书",
    "form_intro": "请在第一次学习前填写本表。带 * 的为必填项。",
    "labels": ["姓名 *", "出生日期（日/月/年）*", "电子邮箱 *", "手机号码", "所属学院", "希望的时段", "我同意参加本研究 *", "签名 *", "日期 *"],
    "session": ["上午", "下午"],
    "faculties": ["理学院", "文学院", "医学院", "工学院"],
    "refs_h": "参考文献",
    "refs": [
        "[1] R. Alvarez, J. Singh. 课堂环境中的遗忘建模. 学习研究学报, 8(2):101-118, 2022.",
        "[2] M. Okafor. 实验室中的间隔效应综述. 记忆研究, 14:1-29, 2019.",
    ],
}

SPACED = [92, 85, 80, 71]
MASSED = [95, 64, 49, 38]
BLUE = HexColor("#2b7de9")
ORANGE = HexColor("#e8833a")
GRID = HexColor("#e3e6ea")
MUTED = HexColor("#6b7280")


def register_fonts():
    pdfmetrics.registerFont(TTFont("Song", "/System/Library/Fonts/Supplemental/Songti.ttc", subfontIndex=6))
    pdfmetrics.registerFont(TTFont("Hei", "/System/Library/Fonts/STHeiti Medium.ttc", subfontIndex=1))


def wrap(text, font, size, width):
    """Greedy wrap that breaks on spaces for Latin text and between any characters for CJK."""
    lines, line = [], ""
    tokens = []
    word = ""
    for ch in text:
        if ord(ch) > 0x2e80:
            if word:
                tokens.append(word)
                word = ""
            tokens.append(ch)
        elif ch == " ":
            tokens.append(word + " ")
            word = ""
        else:
            word += ch
    if word:
        tokens.append(word)
    for token in tokens:
        trial = line + token
        if pdfmetrics.stringWidth(trial.rstrip(), font, size) > width and line:
            lines.append(line.rstrip())
            line = token.lstrip() if token.strip() else ""
            # Keep closing punctuation off the start of a line.
            if line and line[0] in "，。、；：）！？" and lines:
                lines[-1] += line[0]
                line = line[1:]
        else:
            line = trial
    if line.strip():
        lines.append(line.rstrip())
    return lines


class Doc:
    def __init__(self, lang):
        self.s = lang
        zh = lang is ZH
        self.body = "Song" if zh else "Helvetica"
        self.bold = "Hei" if zh else "Helvetica-Bold"
        self.size = 10.5 if zh else 10.5
        self.leading = 17 if zh else 15.5
        self.c = canvas.Canvas(str(HERE / lang["file"]), pagesize=letter)
        self.c.setTitle(lang["title"])
        self.c.setAuthor("L. Moreau, K. Tanaka")
        self.page = 1

    def text(self, x, y, text, font=None, size=None, color=black):
        self.c.setFillColor(color)
        self.c.setFont(font or self.body, size or self.size)
        self.c.drawString(x, y, text)

    def para(self, y, text, width=RIGHT - LEFT, gap=10):
        for line in wrap(text, self.body, self.size, width):
            self.text(LEFT, y, line)
            y -= self.leading
        return y - gap

    def heading(self, y, text, size=14):
        self.text(LEFT, y, text, self.bold, size)
        return y - size - 10

    def footer(self):
        self.text(W / 2 - 3, 40, str(self.page), size=9, color=MUTED)
        self.c.showPage()
        self.page += 1

    def page1(self):
        s = self.s
        y = H - 100
        self.text(LEFT, y, s["title"], self.bold, 22)
        y -= 24
        self.text(LEFT, y, s["byline"], size=11.5, color=MUTED)
        y -= 40
        y = self.heading(y, s["abstract_h"], 12.5)
        y = self.para(y, s["abstract"], gap=18)
        y = self.heading(y, s["intro_h"])
        for paragraph in s["intro"]:
            y = self.para(y, paragraph)
        y -= 6
        y = self.heading(y, s["rq_h"], 12.5)
        self.para(y, s["rq"])
        self.footer()

    def page2(self):
        s = self.s
        y = H - 90
        y = self.heading(y, s["method_h"])
        y = self.para(y, s["method"], gap=14)

        # Figure 1: two lines on a 0-100 grid. Kept to about 250 x 170 pt so the whole chart, legend
        # and axis labels fit the explain lens's box for areas without text (42% x 22% of the page).
        c = self.c
        x0 = W / 2 - 125 + 34
        x1 = x0 + 212
        top = y - 30
        bottom = top - 126
        c.setLineWidth(0.6)
        for value in range(0, 101, 25):
            gy = bottom + (top - bottom) * value / 100
            c.setStrokeColor(GRID)
            c.line(x0, gy, x1, gy)
            self.text(x0 - 32, gy - 3.5, f"{value}%", "Helvetica", 9.5, MUTED)
        xs = [x0 + 18 + (x1 - x0 - 36) * i / 3 for i in range(4)]
        for x, label in zip(xs, s["axis"]):
            width = pdfmetrics.stringWidth(label, self.body, 9.5)
            self.text(x - width / 2, bottom - 15, label, self.body, 9.5, MUTED)
        for values, color in ((SPACED, BLUE), (MASSED, ORANGE)):
            points = [(x, bottom + (top - bottom) * v / 100) for x, v in zip(xs, values)]
            c.setStrokeColor(color)
            c.setLineWidth(2)
            path = c.beginPath()
            path.moveTo(*points[0])
            for point in points[1:]:
                path.lineTo(*point)
            c.drawPath(path, stroke=1, fill=0)
            c.setFillColor(color)
            for px, py in points:
                c.circle(px, py, 2.6, stroke=0, fill=1)
        # Legend on one row: stacked labels would read as a paragraph and cut the figure crop.
        lx = x0
        ly = top + 14
        for label, color in zip(s["legend"], (BLUE, ORANGE)):
            c.setStrokeColor(color)
            c.setLineWidth(2.2)
            c.line(lx, ly + 3, lx + 18, ly + 3)
            self.text(lx + 24, ly, label, self.body, 10)
            lx += 84
        y = bottom - 44
        width = pdfmetrics.stringWidth(s["fig_caption"], self.body, 10)
        self.text(W / 2 - width / 2, y, s["fig_caption"], size=10)
        y -= 34

        # Table 1.
        self.text(LEFT, y, s["table_caption"], size=10)
        y -= 22
        cols = [LEFT + 16, LEFT + 140, LEFT + 250, LEFT + 360]
        for x, head in zip(cols, s["table_head"]):
            self.text(x, y, head, self.bold, 10)
        c.setStrokeColor(black)
        c.setLineWidth(0.8)
        c.line(LEFT + 8, y - 6, LEFT + 450, y - 6)
        days = [1, 7, 14, 30]
        for day, a, b in zip(days, SPACED, MASSED):
            y -= 19
            diff = a - b
            row = [str(day), str(a), str(b), f"{'+' if diff > 0 else '−' if diff < 0 else ''}{abs(diff)}"]
            for x, cell in zip(cols, row):
                self.text(x, y, cell, "Helvetica", 10)
        c.line(LEFT + 8, y - 8, LEFT + 450, y - 8)
        y -= 44

        eq = s["equation"]
        width = pdfmetrics.stringWidth(eq, "Helvetica-Oblique", 13)
        self.text(W / 2 - width / 2, y, eq, "Helvetica-Oblique", 13)
        self.text(RIGHT - 24, y, "(1)", "Helvetica", 11)
        y -= 34
        self.para(y, s["fit"])
        self.footer()

    def page3(self):
        s = self.s
        c = self.c
        form = c.acroForm
        y = H - 90
        y = self.heading(y, s["form_h"])
        y = self.para(y, s["form_intro"], gap=16)
        labels = s["labels"]
        field_x = LEFT + 170
        style = dict(borderColor=HexColor("#9aa4b2"), fillColor=HexColor("#f3f6fb"), textColor=black, borderWidth=0.8, forceBorder=True)

        def row(label):
            nonlocal y
            self.text(LEFT, y + 6, label, size=10.5)

        for name, label, width in (("fullName", labels[0], 250), ("dob", labels[1], 150), ("email", labels[2], 250), ("phone", labels[3], 180)):
            row(label)
            form.textfield(name=name, x=field_x, y=y, width=width, height=20, fontName="Helvetica", fontSize=11, **style)
            y -= 36

        row(labels[4])
        # reportlab can't write CJK option text, so Latin placeholders are swapped in afterwards.
        placeholders = [f"option{i}" for i in range(len(s["faculties"]))]
        form.choice(name="faculty", options=placeholders, value=placeholders[0], x=field_x, y=y, width=160, height=22, fontName="Helvetica", fontSize=11, **style)
        y -= 38

        row(labels[5])
        for i, option in enumerate(s["session"]):
            ox = field_x + i * 110
            form.radio(name="session", value=f"opt{i}", selected=False, x=ox, y=y + 2, size=16, buttonStyle="circle", borderColor=HexColor("#9aa4b2"), fillColor=white, forceBorder=True)
            self.text(ox + 24, y + 6, option, size=10.5)
        y -= 36

        row(labels[6])
        form.checkbox(name="agree", x=field_x, y=y + 2, size=16, checked=False, buttonStyle="check", borderColor=HexColor("#9aa4b2"), fillColor=white, forceBorder=True)
        y -= 44

        c.setStrokeColor(black)
        c.setLineWidth(0.8)
        row(labels[7])
        c.line(field_x, y + 4, field_x + 250, y + 4)
        y -= 36
        row(labels[8])
        c.line(field_x, y + 4, field_x + 130, y + 4)
        y -= 64

        y = self.heading(y, s["refs_h"], 12.5)
        size = self.size
        self.size = 9.5
        self.leading = self.leading - 3
        for ref in s["refs"]:
            y = self.para(y, ref, gap=4)
        self.size = size
        self.footer()

    def build(self):
        self.page1()
        self.page2()
        self.page3()
        self.c.save()


def set_choice_options(lang):
    """Replaces the placeholder dropdown options with the real (possibly CJK) ones."""
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import ArrayObject, NameObject, TextStringObject

    path = HERE / lang["file"]
    writer = PdfWriter(clone_from=PdfReader(str(path)))
    options = ArrayObject(TextStringObject(option) for option in lang["faculties"])
    for page in writer.pages:
        for annot in page.get("/Annots") or []:
            field = annot.get_object()
            if field.get("/T") == "faculty":
                field[NameObject("/Opt")] = options
                field[NameObject("/V")] = TextStringObject(lang["faculties"][0])
                field.pop("/AP", None)
    writer._root_object["/AcroForm"][NameObject("/NeedAppearances")] = __import__("pypdf").generic.BooleanObject(True)
    with open(path, "wb") as out:
        writer.write(out)


if __name__ == "__main__":
    HERE.mkdir(exist_ok=True)
    register_fonts()
    for lang in (EN, ZH):
        Doc(lang).build()
        set_choice_options(lang)
        print("wrote", HERE / lang["file"])
